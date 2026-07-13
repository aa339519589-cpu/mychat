import { existsSync } from 'node:fs'
import type { NextRequest } from 'next/server'
import type { AuthCtx } from '@/lib/api/guard'
import { startAgentRecoveryWatchdog } from '@/lib/agent/isolated-shell'
import { getTaskDetail } from '@/lib/agent/data'
import { isInternalRecoveryToken, sealRecoveryToken } from '@/lib/agent/recovery-token'
import { saveAgentRunState } from '@/lib/agent/run-state'
import { createWorkspaceForTask } from '@/lib/agent/workspace'
import type { GitHubSession } from '@/lib/github-session'
import { repoMeta } from '@/lib/github'
import { log } from '@/lib/logger'
import type { CodeChatRequest } from './request'

export type CodeRunLease = {
  runId: string
  isClaimed: () => boolean
  release: () => Promise<void>
}

export type PreparedCodeRun = {
  supabase: AuthCtx['supabase']
  userId: string | null
  token: string
  login: string
  effectiveTaskId: string | null
  lease: CodeRunLease
  defaultBranch: string | null
  repoIsPrivate: boolean
  memories: string[]
  hasWorkspace: boolean
  workspaceReady: boolean
}

type PreparationResult = { context: PreparedCodeRun; response?: never } | { response: Response; context?: never }

function jsonError(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), { status })
}

function lastGoal(messages: CodeChatRequest['messages']): string {
  return messages.at(-1)?.content.slice(0, 200) || '代码改动'
}

function createRunLease(
  supabase: AuthCtx['supabase'],
  taskId: string | null,
): CodeRunLease & { markClaimed: () => void } {
  const runId = crypto.randomUUID()
  let claimed = false
  return {
    runId,
    isClaimed: () => claimed,
    markClaimed: () => { claimed = true },
    release: async () => {
      if (!claimed || !taskId || !supabase) return
      try {
        await supabase.rpc('release_agent_run', { input_task_id: taskId, input_run_id: runId })
      } catch {}
      claimed = false
    },
  }
}

async function resolveTaskId(
  body: CodeChatRequest,
  auth: AuthCtx,
): Promise<{ taskId: string | null } | { response: Response }> {
  const { repo, taskId, messages } = body
  const { supabase, userId } = auth
  let effectiveTaskId = taskId
  if (!repo || !supabase || !userId) return { taskId: effectiveTaskId }

  if (effectiveTaskId) {
    const { data: taskRow } = await supabase.from('agent_tasks')
      .select('id, repo, status').eq('id', effectiveTaskId).eq('user_id', userId).single()
    if (!taskRow) {
      effectiveTaskId = null
    } else if (taskRow.repo && taskRow.repo !== repo) {
      return { response: Response.json({ error: '任务与仓库不匹配，请重新创建任务' }, { status: 409 }) }
    } else if (taskRow.status === 'cancelled' || taskRow.status === 'completed') {
      return { response: Response.json({ error: `当前任务状态 ${taskRow.status} 不可继续` }, { status: 409 }) }
    }
  }

  if (!effectiveTaskId) {
    const { data: newTask, error } = await supabase.from('agent_tasks')
      .insert({ user_id: userId, goal: lastGoal(messages), repo, status: 'planning', mode: 'auto' })
      .select('id').single()
    if (error || !newTask) {
      console.error('[code/chat] backend task creation failed', {
        message: error?.message, code: error?.code, details: error?.details, hint: error?.hint,
      })
      return { response: jsonError(`Agent Task 创建失败：${error?.message || '未知数据库错误'}`, 500) }
    }
    effectiveTaskId = newTask.id
  }
  return { taskId: effectiveTaskId }
}

async function loadMemories(auth: AuthCtx, repo: string | null): Promise<string[]> {
  const { supabase, userId } = auth
  if (!repo || !supabase || !userId) return []
  try {
    const { data } = await supabase.from('code_memories').select('content')
      .eq('user_id', userId).eq('repo', repo).order('created_at')
    return (data ?? []).map(row => row.content as string)
  } catch {
    return []
  }
}

async function ensureWorkspace(options: {
  auth: AuthCtx
  taskId: string
  token: string
  repo: string
  goal: string
  defaultBranch: string
}): Promise<boolean> {
  const { auth, taskId, token, repo, goal, defaultBranch } = options
  const { supabase, userId } = auth
  if (!supabase || !userId) return false

  const detail = await getTaskDetail(supabase, userId, taskId).catch(() => null)
  if (detail && 'workspace' in detail) {
    const workspace = detail.workspace
    if (
      workspace
      && (workspace.status === 'ready' || workspace.status === 'dirty')
      && workspace.path
      && existsSync(workspace.path)
    ) return true
  }

  try {
    const result = await createWorkspaceForTask(
      supabase, userId, taskId, token, repo, goal, defaultBranch,
    )
    if (result && !('error' in result) && result.path && existsSync(result.path)) return true
    if (result && 'error' in result) console.error('[code/chat] workspace pre-create failed', result.error)
  } catch (error) {
    console.error('[code/chat] workspace pre-create exception', error instanceof Error ? error.message : String(error))
  }
  return false
}

export async function prepareCodeRun(
  req: NextRequest,
  body: CodeChatRequest,
  auth: AuthCtx,
  githubSession: GitHubSession,
): Promise<PreparationResult> {
  const { supabase, userId } = auth
  const { repo } = body
  const resolved = await resolveTaskId(body, auth)
  if ('response' in resolved) return resolved

  const effectiveTaskId = resolved.taskId
  const lease = createRunLease(supabase, effectiveTaskId)
  if (effectiveTaskId && supabase && userId) {
    const { data: claimed, error } = await supabase.rpc('claim_agent_run', {
      input_task_id: effectiveTaskId,
      input_run_id: lease.runId,
      lease_seconds: 120,
    })
    if (!error) {
      if (claimed !== true) return { response: Response.json({ error: '任务已有执行进程，请稍后重试' }, { status: 409 }) }
      lease.markClaimed()
    } else {
      log.warn('codeChat', 'Run lease RPC unavailable; continuing in compatibility mode', { code: error.code })
    }
  }

  if (effectiveTaskId && supabase && userId && repo) {
    await saveAgentRunState(supabase, userId, effectiveTaskId, {
      repo,
      tier: body.tier,
      messages: body.messages,
      responseId: body.responseId ?? undefined,
      sessionId: body.sessionId ?? undefined,
      updatedAt: new Date().toISOString(),
    })
    const recoveryToken = sealRecoveryToken({
      taskId: effectiveTaskId,
      cookie: req.headers.get('cookie') ?? '',
      expiresAt: Date.now() + 2 * 60 * 60_000,
    })
    if (recoveryToken && !isInternalRecoveryToken(req.headers.get('x-agent-recovery'))) {
      const origin = process.env.AGENT_PUBLIC_URL?.trim() || req.nextUrl.origin
      await startAgentRecoveryWatchdog(
        supabase,
        userId,
        effectiveTaskId,
        `${origin}/api/agent/tasks/${effectiveTaskId}/recover`,
        recoveryToken,
      ).catch(error => log.warn('codeChat', 'Recovery watchdog unavailable', { error: String(error) }))
    }
  }

  let defaultBranch: string | null = null
  let repoIsPrivate = false
  if (repo) {
    const meta = await repoMeta(githubSession.token, repo)
    if (!meta) {
      await lease.release()
      return { response: jsonError('仓库访问失败，请重新连接 GitHub', 502) }
    }
    defaultBranch = meta.defaultBranch
    repoIsPrivate = meta.isPrivate
  }

  const hasWorkspace = Boolean(repo && effectiveTaskId)
  const workspaceReady = hasWorkspace
    ? await ensureWorkspace({
        auth,
        taskId: effectiveTaskId!,
        token: githubSession.token,
        repo: repo!,
        goal: lastGoal(body.messages),
        defaultBranch: defaultBranch ?? 'main',
      })
    : false
  if (hasWorkspace && !workspaceReady) {
    await lease.release()
    return { response: jsonError('Workspace 创建失败，无法在当前仓库工作。请刷新页面重试。', 500) }
  }

  return {
    context: {
      supabase,
      userId,
      token: githubSession.token,
      login: githubSession.login,
      effectiveTaskId,
      lease,
      defaultBranch,
      repoIsPrivate,
      memories: await loadMemories(auth, repo),
      hasWorkspace,
      workspaceReady,
    },
  }
}
