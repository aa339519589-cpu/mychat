import { existsSync } from 'node:fs'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getTaskDetail, updateTaskStatus } from '@/lib/agent/data'
import { publishWorkspaceToPullRequest, getWorkspaceGitStatus } from '@/lib/agent/git-publish'
import { createWorkspaceForTask } from '@/lib/agent/workspace'
import { mergeTaskMeta } from '@/lib/agent/meta'
import { clearConfirmation, createConfirmationRequest, getConfirmation } from '@/lib/agent/permissions'
import { classifyPublishRisk } from '@/lib/agent/risk'
import { enablePages, mergePullRequest, repoMeta } from '@/lib/github'
import { applyOutcome, type CodeApplyOutcome } from './apply-contract'
import { resolveBoundRepository, type CodeApplyRequest } from './apply-request'

export async function publishWorkspaceRequest(
  input: CodeApplyRequest,
  taskId: string,
  token: string,
  supabase: SupabaseClient,
  userId: string,
): Promise<CodeApplyOutcome> {
  const detail = await getTaskDetail(supabase, userId, taskId)
  if (!('workspace' in detail)) {
    return applyOutcome({ error: '任务不存在或无权访问' }, 404)
  }
  let targetRepo: string
  try {
    targetRepo = resolveBoundRepository(input.repo, detail.repo)
  } catch (error) {
    return applyOutcome({ error: error instanceof Error ? error.message : '仓库参数无效' }, 400)
  }

  let workspace = detail.workspace
  if (
    !workspace
    || workspace.status === 'created'
    || workspace.status === 'cloning'
    || workspace.status === 'failed'
    || !workspace.path
    || !existsSync(workspace.path)
  ) {
    try {
      let defaultBranch = 'main'
      try {
        const metadata = await repoMeta(token, targetRepo)
        if (metadata?.defaultBranch) defaultBranch = metadata.defaultBranch
      } catch {
        // Workspace creation retains the established main-branch fallback.
      }
      const created = await createWorkspaceForTask(
        supabase,
        userId,
        taskId,
        token,
        targetRepo,
        detail.goal ?? '代码改动',
        defaultBranch,
      )
      if (created && !('error' in created) && created.path && existsSync(created.path)) {
        workspace = {
          ...(workspace ?? {
            id: '', taskId, userId, repo: targetRepo, branch: 'main', commitSha: null,
            path: created.path, status: 'ready', createdAt: '', updatedAt: '',
          }),
          path: created.path,
          status: 'ready',
        }
      }
    } catch {
      return applyOutcome({ error: 'Workspace 创建失败，无法发布 PR' }, 502)
    }
  }

  if (!workspace?.path || !existsSync(workspace.path)) {
    return applyOutcome({ error: 'Workspace 不存在，无法发布 PR' }, 400)
  }

  const status = getWorkspaceGitStatus(taskId, userId)
  const resumable = !!detail.commitSha && detail.commitSha === status.commitSha && !detail.pullRequestUrl
  if (!status.hasChanges && !resumable) {
    return applyOutcome({
      error: 'Workspace 没有待提交的改动',
      detail: { mode: 'workspace_pr', status: '无改动' },
    }, 400)
  }

  const committedFiles = [...detail.artifacts]
    .reverse()
    .find(artifact => artifact.kind === 'diff' && Array.isArray(artifact.meta?.changedFiles))
    ?.meta?.changedFiles
  const riskFiles = status.changedFiles?.length
    ? status.changedFiles.map(file => file.path)
    : Array.isArray(committedFiles)
      ? committedFiles.filter((file): file is string => typeof file === 'string')
      : []
  const risk = classifyPublishRisk(riskFiles, status.currentBranch ?? '')
  if (risk.blocked) return applyOutcome({ error: risk.reason, blocked: true }, 403)
  if (risk.needsConfirmation) {
    const confirmation = await getConfirmation(supabase, userId, taskId)
    if (confirmation?.status === 'confirmed' && confirmation.operation === 'publish') {
      await clearConfirmation(supabase, userId, taskId)
    } else if (confirmation?.status === 'pending') {
      return applyOutcome({
        error: '高风险改动需要先在 Agent 任务面板确认',
        needsConfirmation: true,
        confirmationId: confirmation.id,
        risk,
      }, 409)
    } else {
      if (confirmation) await clearConfirmation(supabase, userId, taskId)
      const created = await createConfirmationRequest(supabase, userId, taskId, risk, 'creating_pr')
      return applyOutcome({
        error: '高风险改动需要先在 Agent 任务面板确认',
        needsConfirmation: true,
        confirmationId: created.id,
        risk,
      }, 409)
    }
  }

  const published = await publishWorkspaceToPullRequest(taskId, userId, token, supabase, {
    message: input.message || undefined,
  })
  if (!published.ok) {
    return applyOutcome({
      error: published.error || '发布失败',
      detail: {
        mode: 'workspace_pr',
        stage: published.stage,
        status: published.status?.hasChanges ? '有改动' : '无改动',
        commitSha: published.commit?.commitSha,
      },
    }, 502)
  }

  const deployPages = detail.meta?.deployPages === true
  let merged = false
  let mergeCommitSha: string | undefined
  let pagesUrl: string | undefined
  let pagesStatus: 'ready' | 'pending' | 'failed' | undefined
  let pagesError: string | undefined

  if (deployPages) {
    await updateTaskStatus(supabase, userId, taskId, 'deploying')
    const pullNumber = published.pr?.pullRequestNumber
    const headSha = published.commit?.commitSha
    if (!pullNumber || !headSha || !targetRepo) {
      await updateTaskStatus(supabase, userId, taskId, 'failed', {
        error: '缺少合并信息',
        finishedAt: new Date().toISOString(),
      })
      return applyOutcome({ error: 'Pull Request 已创建，但缺少合并信息，无法继续上线' }, 502)
    }

    const merge = await mergePullRequest(token, targetRepo, pullNumber, headSha)
    if (!merge.merged) {
      await mergeTaskMeta(supabase, userId, taskId, {
        deploymentStatus: 'blocked',
        deploymentError: merge.error,
      })
      await supabase.from('agent_tasks')
        .update({ status: 'failed', error: merge.error, updated_at: new Date().toISOString() })
        .eq('id', taskId)
        .eq('user_id', userId)
      return applyOutcome({ error: `Pull Request 已创建，但 GitHub 没有允许自动合并：${merge.error}` }, 409)
    }

    merged = true
    mergeCommitSha = merge.commitSha
    const metadata = await repoMeta(token, targetRepo)
    const baseBranch = metadata?.defaultBranch ?? detail.branch ?? 'main'
    const pages = await enablePages(token, targetRepo, baseBranch, {
      verifyUrl: !metadata?.isPrivate,
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

  return applyOutcome({
    mode: 'workspace_pr',
    pullRequestUrl: published.pr?.pullRequestUrl,
    pullRequestNumber: published.pr?.pullRequestNumber,
    commitSha: published.commit?.commitSha,
    branch: published.push?.branch,
    merged,
    mergeCommitSha,
    pagesUrl,
    pagesStatus,
    pagesError,
    changedFiles: published.status?.changedFiles,
    message: deployPages
      ? pagesStatus === 'ready'
        ? '已通过 Pull Request 合并并完成网页部署'
        : pagesStatus === 'failed'
          ? '已通过 Pull Request 合并，但网页部署失败，Agent 将继续排查'
          : '已通过 Pull Request 合并，网页仍在部署'
      : '已创建 Pull Request（非直推 main）',
  })
}
