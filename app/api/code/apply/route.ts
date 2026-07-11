import { repoMeta, createRepo, commitFiles, enablePages, mergePullRequest, type FileWrite } from '@/lib/github'
import { resolveAuth } from '@/lib/api/guard'
import { getTaskDetail, updateTaskStatus } from '@/lib/agent/data'
import { publishWorkspaceToPullRequest, getWorkspaceGitStatus } from '@/lib/agent/git-publish'
import { existsSync } from 'fs'
import { createWorkspaceForTask } from '@/lib/agent/workspace'
import type { PlanAction } from '@/lib/code-data'
import { getGitHubSession } from '@/lib/github-session'
import { readJson, requestErrorResponse } from '@/lib/api/request'
import { mergeTaskMeta } from '@/lib/agent/meta'
import { classifyPublishRisk } from '@/lib/agent/risk'
import { clearConfirmation, createConfirmationRequest, getConfirmation } from '@/lib/agent/permissions'

// 用户在 Code 里点「确认」(或自动模式)后调用：
//   - 有 taskId + ready workspace → 发布为 Pull Request
//   - 无 taskId → 仅允许创建新仓库并完成首次提交
export async function POST(req: Request) {
  const githubSession = await getGitHubSession()
  if (!githubSession) return Response.json({ error: '未连接 GitHub 或账号会话已变化' }, { status: 401 })
  const token = githubSession.token

  let body: any
  try { body = await readJson(req, { maxBytes: 2 * 1024 * 1024 }) } catch (error) { return requestErrorResponse(error) }
  const { repo: sessionRepo, actions, message, taskId, mode } = body as {
    repo: string | null; actions: PlanAction[]; message: string; taskId?: string; mode?: string
  }
  if (sessionRepo !== null && sessionRepo !== undefined && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(sessionRepo)) {
    return Response.json({ error: '仓库参数无效' }, { status: 400 })
  }
  if (taskId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskId)) {
    return Response.json({ error: 'taskId 无效' }, { status: 400 })
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
    const resumablePublish = !!detail.commitSha && detail.commitSha === wsStatus.commitSha && !detail.pullRequestUrl
    if (!wsStatus.hasChanges && !resumablePublish) {
      return Response.json({
        error: 'Workspace 没有待提交的改动',
        detail: { mode: "workspace_pr", status: "无改动" },
      }, { status: 400 })
    }

    const committedFiles = [...detail.artifacts].reverse().find(artifact => artifact.kind === 'diff' && Array.isArray(artifact.meta?.changedFiles))?.meta?.changedFiles
    const riskFiles = wsStatus.changedFiles?.length
      ? wsStatus.changedFiles.map(file => file.path)
      : Array.isArray(committedFiles) ? committedFiles.filter((file): file is string => typeof file === 'string') : []
    const risk = classifyPublishRisk(riskFiles, wsStatus.currentBranch ?? '')
    if (risk.blocked) return Response.json({ error: risk.reason, blocked: true }, { status: 403 })
    if (risk.needsConfirmation) {
      const confirmation = await getConfirmation(supabase, userId, taskId)
      if (confirmation?.status === 'confirmed' && confirmation.operation === 'publish') {
        await clearConfirmation(supabase, userId, taskId)
      } else if (confirmation?.status === 'pending') {
        return Response.json({ error: '高风险改动需要先在 Agent 任务面板确认', needsConfirmation: true, confirmationId: confirmation.id, risk }, { status: 409 })
      } else {
        if (confirmation) await clearConfirmation(supabase, userId, taskId)
        const created = await createConfirmationRequest(supabase, userId, taskId, risk, 'creating_pr')
        return Response.json({ error: '高风险改动需要先在 Agent 任务面板确认', needsConfirmation: true, confirmationId: created.id, risk }, { status: 409 })
      }
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

    const targetRepo = sessionRepo ?? detail.repo ?? ""
    const deployPages = detail.meta?.deployPages === true
    let merged = false
    let mergeCommitSha: string | undefined
    let pagesUrl: string | undefined
    let pagesStatus: "ready" | "pending" | "failed" | undefined
    let pagesError: string | undefined

    if (deployPages) {
      await updateTaskStatus(supabase, userId, taskId, 'deploying')
      const pullNumber = result.pr?.pullRequestNumber
      const headSha = result.commit?.commitSha
      if (!pullNumber || !headSha || !targetRepo) {
        await updateTaskStatus(supabase, userId, taskId, 'failed', { error: '缺少合并信息', finishedAt: new Date().toISOString() })
        return Response.json({ error: 'Pull Request 已创建，但缺少合并信息，无法继续上线' }, { status: 502 })
      }
      const merge = await mergePullRequest(token, targetRepo, pullNumber, headSha)
      if (!merge.merged) {
        await mergeTaskMeta(supabase, userId, taskId, { deploymentStatus: 'blocked', deploymentError: merge.error })
        await supabase.from('agent_tasks').update({ status: 'failed', error: merge.error, updated_at: new Date().toISOString() })
          .eq('id', taskId).eq('user_id', userId)
        return Response.json({ error: `Pull Request 已创建，但 GitHub 没有允许自动合并：${merge.error}` }, { status: 409 })
      }
      merged = true
      mergeCommitSha = merge.commitSha
      const meta = await repoMeta(token, targetRepo)
      const baseBranch = meta?.defaultBranch ?? detail.branch ?? 'main'
      const pages = await enablePages(token, targetRepo, baseBranch, {
        verifyUrl: !meta?.isPrivate,
        expectedCommitSha: mergeCommitSha,
      })
      pagesUrl = pages.url
      pagesStatus = pages.status
      if (pages.status === 'failed') pagesError = pages.error
      await mergeTaskMeta(supabase, userId, taskId, {
        deployPages: true,
        deploymentStatus: pages.status,
        pagesUrl: pages.url,
        deploymentError: pages.status === 'failed' ? pages.error : null,
        mergeCommitSha,
      })
      await updateTaskStatus(
        supabase,
        userId,
        taskId,
        pages.status === 'ready' ? 'completed' : pages.status === 'failed' ? 'failed' : 'deploying',
        pages.status === 'failed'
          ? { error: pages.error, finishedAt: new Date().toISOString() }
          : pages.status === 'ready'
            ? { error: null, finishedAt: new Date().toISOString() }
            : { error: null, finishedAt: null },
      )
    }

    return Response.json({
      mode: "workspace_pr",
      pullRequestUrl: result.pr?.pullRequestUrl,
      pullRequestNumber: result.pr?.pullRequestNumber,
      commitSha: result.commit?.commitSha,
      branch: result.push?.branch,
      merged,
      mergeCommitSha,
      pagesUrl,
      pagesStatus,
      pagesError,
      changedFiles: result.status?.changedFiles,
      message: deployPages
        ? pagesStatus === 'ready'
          ? "已通过 Pull Request 合并并完成网页部署"
          : pagesStatus === 'failed'
            ? "已通过 Pull Request 合并，但网页部署失败，Agent 将继续排查"
            : "已通过 Pull Request 合并，网页仍在部署"
        : "已创建 Pull Request（非直推 main）",
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
    const pages = await enablePages(token, targetRepo, targetBranch, {
      verifyUrl: !createAction.private,
      expectedCommitSha: result.commitSha,
    })
    result.pagesUrl = pages.url
    result.pagesStatus = pages.status
    if (pages.status === 'failed') result.pagesError = pages.error
  }

  return Response.json({ ...result, mode: "direct_push" })
}
