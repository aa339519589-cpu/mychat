import { cookies } from 'next/headers'
import { repoMeta, createRepo, commitFiles, enablePages, type FileWrite } from '@/lib/github'
import { resolveAuth } from '@/lib/api/guard'
import { createRecorder } from '@/lib/agent/recorder'

// 用户在 Code 里点「确认」(或自动模式)后调用：把 AI 的改动计划【直接执行】到 GitHub。
// 直接推送默认分支（用户已选），不走 PR。安全闸：≤20 文件、总量 ≤1MB、写操作前校验写权限。
export type PlanAction =
  | { kind: 'create_repo'; name: string; description?: string; private?: boolean }
  | { kind: 'write_file'; path: string; newContent: string }
  | { kind: 'delete_file'; path: string }
  | { kind: 'enable_pages' }

export async function POST(req: Request) {
  const store = await cookies()
  const token = store.get('gh_access_token')?.value
  if (!token) return Response.json({ error: '未连接 GitHub' }, { status: 401 })

  const body = await req.json().catch(() => null)
  if (!body) return Response.json({ error: '请求体格式错误' }, { status: 400 })
  const { repo: sessionRepo, actions, message, taskId } = body as { repo: string | null; actions: PlanAction[]; message: string; taskId?: string }
  if (!Array.isArray(actions) || actions.length === 0) return Response.json({ error: '没有要执行的改动' }, { status: 400 })

  // Agent Task recorder
  const auth = await resolveAuth()
  const recorder = createRecorder({ supabase: auth.supabase, userId: auth.userId, taskId: taskId ?? null })

  const writes = actions.filter(a => a.kind === 'write_file') as Extract<PlanAction, { kind: 'write_file' }>[]
  const deletes = actions.filter(a => a.kind === 'delete_file') as Extract<PlanAction, { kind: 'delete_file' }>[]
  if (writes.length + deletes.length > 20) return Response.json({ error: '单次最多改动 20 个文件' }, { status: 400 })
  const totalSize = writes.reduce((s, w) => s + (w.newContent?.length ?? 0), 0)
  if (totalSize > 1_000_000) return Response.json({ error: '内容总量超过 1MB 限制' }, { status: 400 })

  const result: { repoUrl?: string; pagesUrl?: string; commitSha?: string; repo?: string; created?: boolean } = {}

  let targetRepo = sessionRepo
  let targetBranch: string | null = null

  // 1) 新建仓库（若有）
  const createAction = actions.find(a => a.kind === 'create_repo') as Extract<PlanAction, { kind: 'create_repo' }> | undefined
  if (createAction) {
    const r = await createRepo(token, createAction.name, createAction.description ?? '', !!createAction.private)
    if ('error' in r) {
      await recorder.setTaskStatus("failed", r.error)
      await recorder.step("failed", "创建仓库失败", r.error)
      return Response.json({ error: r.error }, { status: 502 })
    }
    targetRepo = r.fullName
    targetBranch = r.defaultBranch
    result.repoUrl = r.htmlUrl
    result.repo = r.fullName
    result.created = true
  }

  if (!targetRepo) return Response.json({ error: '没有目标仓库（请先选仓库，或让 AI 新建一个）' }, { status: 400 })

  // 解析默认分支 + 校验写权限（新建的仓库已知分支，跳过远程校验）
  if (!targetBranch) {
    const meta = await repoMeta(token, targetRepo)
    if (!meta) return Response.json({ error: '仓库访问失败' }, { status: 502 })
    if (!meta.canPush) return Response.json({ error: '你对该仓库没有写入权限' }, { status: 403 })
    targetBranch = meta.defaultBranch
  }
  result.repo = targetRepo

  // 2) 文件改动打成一个原子提交
  if (writes.length || deletes.length) {
    const files: FileWrite[] = [
      ...writes.map(w => ({ path: w.path, content: w.newContent })),
      ...deletes.map(d => ({ path: d.path, content: null })),
    ]
    const c = await commitFiles(token, targetRepo, targetBranch, files, message || 'Claude 代码改动')
    if ('error' in c) return Response.json({ error: c.error }, { status: 502 })
    result.commitSha = c.commitSha
  }

  // 3) 开启 Pages（若有）
  if (actions.some(a => a.kind === 'enable_pages')) {
    const p = await enablePages(token, targetRepo, targetBranch)
    if (!('error' in p)) result.pagesUrl = p.url
  }

  // Agent Task 记录：改动已应用
  await recorder.step("done", `应用完成 · ${result.commitSha ? `commit ${result.commitSha.slice(0, 7)}` : ''}${result.pagesUrl ? ` · 已上线` : ''}`)
  if (result.repoUrl || targetRepo) {
    await recorder.artifact("deploy", {
      title: "仓库",
      url: result.repoUrl ?? `https://github.com/${targetRepo}`,
      content: result.created ? `新建仓库: ${targetRepo}` : `提交: ${result.commitSha ?? '无'}`,
    })
  }
  if (result.pagesUrl) {
    await recorder.artifact("deploy", { title: "上线地址", url: result.pagesUrl })
  }
  if (result.commitSha) {
    await recorder.artifact("diff", {
      title: `commit ${result.commitSha.slice(0, 7)}`,
      content: `提交信息: ${message}\n文件数: ${writes.length + deletes.length}`,
      meta: { commitSha: result.commitSha, repo: targetRepo, branch: targetBranch ?? "main" },
    })
  }
  await recorder.setTaskStatus("completed")
  await recorder.step("completed", "任务完成")

  return Response.json(result)
}
