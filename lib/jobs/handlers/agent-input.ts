import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { SupabaseClient } from '@supabase/supabase-js'
import { TIER_MAP, type Tier } from '@/lib/chat-data'
import { getTaskDetail } from '@/lib/agent/data'
import { createWorkspaceForTask } from '@/lib/agent/workspace'
import {
  advanceWorkspaceAuthority,
  bindWorkspaceBranch,
  readWorkspaceAuthority,
  restoreWorkspaceAuthority,
} from '@/lib/agent/workspace-authority'
import { workspaceRoot } from '@/lib/agent/workspace-paths'
import { getGitHubCredentialForUser } from '@/lib/github-connection'
import { repoMeta } from '@/lib/github'
import { createAdminClient } from '@/lib/supabase/admin'
import type { CodeChatMessage } from '@/lib/code-agent/request'
import type { JobExecutionContext } from '../worker'
import { JobRuntimeError } from '../errors'

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
}

function required(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw new JobRuntimeError('JOB_INVALID_INPUT', `Missing ${name}`)
  return value
}

export type LoadedAgentJob = {
  client: SupabaseClient
  userId: string
  taskId: string
  repo: string
  sessionId: string
  responseId: string
  userMessageId: string
  messages: CodeChatMessage[]
  token: string
  login: string
  defaultBranch: string
  repoIsPrivate: boolean
  memories: string[]
  workspaceReady: boolean
  model: string
  thinking: boolean
  usingBalance: boolean
}

export async function loadAgentJob(context: JobExecutionContext): Promise<LoadedAgentJob> {
  const client = createAdminClient()
  if (!client) throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Database authority is unavailable')
  const userId = context.job.principal.id
  const taskId = required(context.job.subject.taskId, 'taskId')
  const repo = required(context.job.subject.repo, 'repo')
  const sessionId = required(context.job.subject.sessionId, 'sessionId')
  const responseId = required(context.job.subject.responseId, 'responseId')
  const userMessageId = required(context.job.subject.userMessageId, 'userMessageId')
  const payload = object(context.job.input)
  const tier = typeof payload.tier === 'string' ? payload.tier : '正构'
  const selected = tier === '观照' ? TIER_MAP['正构'] : (TIER_MAP[tier as Tier] ?? TIER_MAP['正构'])
  const [{ data: task, error: taskError }, { data: source, error: sourceError }, memoriesResult] = await Promise.all([
    client.from('agent_tasks').select('id,repo,goal,status,agent_branch').eq('id', taskId).eq('user_id', userId).maybeSingle(),
    client.from('code_messages').select('id,created_at').eq('id', userMessageId)
      .eq('session_id', sessionId).eq('user_id', userId).eq('role', 'user').maybeSingle(),
    client.from('code_memories').select('content').eq('user_id', userId).eq('repo', repo).order('created_at'),
  ])
  if (taskError || sourceError || memoriesResult.error) {
    throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Agent context is unavailable')
  }
  if (!task || task.repo !== repo || !source) throw new JobRuntimeError('JOB_CONFLICT', 'Agent authority mismatch')
  const { data: messageRows, error: messagesError } = await client.from('code_messages')
    .select('id,role,content,created_at').eq('session_id', sessionId).eq('user_id', userId)
    .in('role', ['user', 'assistant']).lte('created_at', source.created_at)
    .order('created_at', { ascending: true }).limit(200)
  if (messagesError) throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Agent messages are unavailable')
  const messages = (messageRows ?? []).flatMap(row => (
    (row.role === 'user' || row.role === 'assistant') && typeof row.content === 'string'
      ? [{ role: row.role, content: row.content } as CodeChatMessage] : []
  ))
  if (!messages.length || !messageRows?.some(row => row.id === userMessageId)) {
    throw new JobRuntimeError('JOB_NOT_FOUND', 'Agent user message does not exist')
  }
  const credential = await getGitHubCredentialForUser(userId, {
    actorType: 'worker', actorId: context.fence.workerId,
    purpose: 'agent.job', requestId: context.job.id,
  })
  if (!credential) throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'GitHub credential is unavailable', {
    class: 'policy', retryable: false,
  })
  const metadata = await repoMeta(credential.token, repo)
  if (!metadata) throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Repository metadata is unavailable', {
    class: 'provider',
  })
  let workspaceReady = false
  const authority = await readWorkspaceAuthority(client, userId, taskId)
  let workspaceBranch = typeof task.agent_branch === 'string' && task.agent_branch
    ? task.agent_branch : `agent/task-${taskId.slice(0, 8)}`
  const detail = await getTaskDetail(client, userId, taskId).catch(() => null)
  if (detail && 'workspace' in detail && detail.workspace?.path
    && (detail.workspace.status === 'ready' || detail.workspace.status === 'dirty')
    && existsSync(detail.workspace.path)) workspaceReady = true
  if (!workspaceReady) {
    const created = await createWorkspaceForTask(
      client, userId, taskId, credential.token, repo,
      typeof task.goal === 'string' ? task.goal : '代码任务', metadata.defaultBranch,
      !authority,
    )
    workspaceReady = Boolean(created && !('error' in created) && created.path && existsSync(created.path))
    if (created && !('error' in created) && !task.agent_branch) workspaceBranch = created.agentBranch
  }
  if (!workspaceReady) throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Workspace creation failed')
  if (!task.agent_branch) {
    try {
      workspaceBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: workspaceRoot(taskId, userId), timeout: 10_000, encoding: 'utf8',
      }).trim()
    } catch {
      throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Workspace branch cannot be determined')
    }
  }
  workspaceBranch = await bindWorkspaceBranch(context, client, workspaceBranch)
  if (authority) {
    await restoreWorkspaceAuthority({
      client, userId, taskId, token: credential.token, branch: workspaceBranch, authority,
    })
  } else {
    await advanceWorkspaceAuthority(context, client, userId, taskId, 'initial-worker-hydration')
  }
  return {
    client, userId, taskId, repo, sessionId, responseId, userMessageId, messages,
    token: credential.token,
    login: credential.login,
    defaultBranch: metadata.defaultBranch,
    repoIsPrivate: metadata.isPrivate,
    memories: (memoriesResult.data ?? []).flatMap(row => typeof row.content === 'string' ? [row.content] : []),
    workspaceReady,
    model: selected.model,
    thinking: selected.thinking,
    usingBalance: payload.usingBalance === true,
  }
}
