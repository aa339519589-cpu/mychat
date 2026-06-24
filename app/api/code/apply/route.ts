import { cookies } from 'next/headers'
import { repoMeta, createRepo, commitFiles, enablePages, type FileWrite } from '@/lib/github'
import { resolveAuth } from '@/lib/api/guard'
import { getTaskDetail } from '@/lib/agent/data'
import { publishWorkspaceToPullRequest, getWorkspaceGitStatus } from '@/lib/agent/git-publish'
import { existsSync } from 'fs'
import { createWorkspaceForTask } from '@/lib/agent/workspace'
import type { PlanAction } from '@/lib/code-data'

// 用户在 Code 里点「确认」(或自动模式)后调用：
//   - 有 taskId + ready workspace → 发布为 Pull Request
//   - 无 taskId → 仅允许创建新仓库并完成首次提交
export async function POST(req: Request) {
  const store = await cookies()
  const token = store.get('gh_access_token')?.value
  if (!token) return Response.json({ error: '未连接 GitHub' }, { status: 401 })

  const body = await req.json().catch(() => null)
  if (!body) return Response.json({ error: '请求体格式错误' }, { status: 400 })
  const { repo: sessionRepo, actions, message, taskId, mode } = body as {
    repo: string | null; actions: PlanAction[]; message: string; taskId?: string; mode?: string
  }

  // ── Workspace PR 模式（body.mode === "workspace_pr" 或 taskId 存在 → 强制 PR，绝不 fallback）──
  if (mode === "workspace_pr" || taskId) {
    if (!taskId) {
      return Response.json({ error: 'mode=workspace_pr 但缺少 taskId' }, { status: 400 })
    }

    const auth = await resolveAuth()
    const supabase = auth.supabase
    const userId = auth.userId

    if (!supabase || !userId) {
      return Response.json({ error: '未登录' }, { status: 401 })
    }

    const detail = await getTaskDetail(supabase, userId, taskId)
    if (!("workspace" in detail)) {
      return Response.json({ error: '任务不存在或无权访问' }, { status: 404 })
    }

    let ws = detail.workspace

    // 如果 workspace 不存在，自动创建
    if (!ws || ws.status === "created" || ws.status === "cloning" || ws.status === "failed" || !ws.path || !existsSync(ws.path)) {
      try {
        const targetRepo = sessionRepo ?? detail.repo ?? ""
        let defaultBranch = "main"
        try {
          const meta = await repoMeta(token, targetRepo)
          if (meta?.defaultBranch) defaultBranch = meta.defaultBranch
        } catch { /* fallback to "main" */ }

        const result = await createWorkspaceForTask(
          supabase, userId, taskId, token, targetRepo, detail.goal ?? "代码改动", defaultBranch,
        )
        if (result && !("error" in result) && result.path && existsSync(result.path)) {
          ws = { ...(ws ?? { id: "", taskId, userId, repo: sessionRepo ?? "", branch: "main", commitSha: null, path: result.path, status: "ready", createdAt: "", updatedAt: "" }), path: result.path, status: "ready" }
        }
      } catch {
        // workspace 创建失败，报错，不回退 direct_push
        return Response.json({ error: 'Workspace 创建失败，无法发布 PR' }, { status: 502 })
      }
    }

    // 有 taskId 必须走 workspace PR，绝不 fallback
    if (!ws || !ws.path || !existsSync(ws.path)) {
      return Response.json({ error: 'Workspace 不存在，无法发布 PR' }, { status: 400 })
    }

    // 检查 workspace 是否有改动
    const wsStatus = getWorkspaceGitStatus(taskId, userId)
    if (!wsStatus.hasChanges) {
      return Response.json({
        error: 'Workspace 没有待提交的改动',
        detail: { mode: "workspace_pr", status: "无改动" },
      }, { status: 400 })
    }

    // 有 ready/dirty workspace：走 PR 发布
    const result = await publishWorkspaceToPullRequest(taskId, userId, token, supabase, {
      message: message || undefined,
    })

    if (!result.ok) {
      const errorMsg = result.error || "发布失败"
      return Response.json({
        error: errorMsg,
        detail: {
          mode: "workspace_pr",
          stage: result.stage,
          status: result.status?.hasChanges ? "有改动" : "无改动",
          commitSha: result.commit?.commitSha,
        },
      }, { status: 502 })
    }

    return Response.json({
      mode: "workspace_pr",
      pullRequestUrl: result.pr?.pullRequestUrl,
      pullRequestNumber: result.pr?.pullRequestNumber,
      commitSha: result.commit?.commitSha,
      branch: result.push?.branch,
      changedFiles: result.status?.changedFiles,
      message: "已创建 Pull Request（非直推 main）",
    })
  }

  // 无 taskId 只允许新建仓库；已有仓库必须走 workspace PR。
  if (!Array.isArray(actions) || actions.length === 0) {
    return Response.json({ error: '没有要执行的改动' }, { status: 400 })
  }
  const createAction = actions.find(a => a.kind === 'create_repo') as Extract<PlanAction, { kind: 'create_repo' }> | undefined
  if (!createAction) {
    return Response.json({ error: '已有仓库必须通过 workspace 创建 Pull Request' }, { status: 400 })
  }

  const writes = actions.filter(a => a.kind === 'write_file') as Extract<PlanAction, { kind: 'write_file' }>[]
  const deletes = actions.filter(a => a.kind === 'delete_file') as Extract<PlanAction, { kind: 'delete_file' }>[]
  if (writes.length + deletes.length > 20) return Response.json({ error: '单次最多改动 20 个文件' }, { status: 400 })
  const totalSize = writes.reduce((s, w) => s + (w.newContent?.length ?? 0), 0)
  if (totalSize > 1_000_000) return Response.json({ error: '内容总量超过 1MB 限制' }, { status: 400 })

  const result: {
    repoUrl?: string; pagesUrl?: string; commitSha?: string; repo?: string; created?: boolean
    pagesStatus?: "ready" | "pending" | "failed"; pagesError?: string
  } = {}

  const created = await createRepo(token, createAction.name, createAction.description ?? '', !!createAction.private)
  if ('error' in created) return Response.json({ error: created.error }, { status: 502 })
  const targetRepo = created.fullName
  const targetBranch = created.defaultBranch
  Object.assign(result, { repoUrl: created.htmlUrl, repo: targetRepo, created: true })

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
    const pages = await enablePages(token, targetRepo, targetBranch, { verifyUrl: !createAction.private })
    result.pagesUrl = pages.url
    result.pagesStatus = pages.status
    if (pages.status === 'failed') result.pagesError = pages.error
  }

  return Response.json({ ...result, mode: "direct_push" })
}
