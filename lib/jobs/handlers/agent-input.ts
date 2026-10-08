import { existsSync } from 'node:fs'
import type { SupabaseServer } from '@/lib/api/guard'
import { getTaskDetail } from '@/lib/agent/data'
import { isValidGitHubRepository } from '@/lib/agent/git-publish/shared'
import { createWorkspaceForTask } from '@/lib/agent/workspace'
import {
  advanceWorkspaceAuthority,
  bindWorkspaceBranch,
  readWorkspaceAuthority,
  restoreWorkspaceAuthority,
} from '@/lib/agent/workspace-authority'
import {
  ChatModelSelectionError,
  type ChatModelSelection,
} from '@/lib/chat/model-selection'
import { codeAgentMode, type CodeAgentMode } from '@/lib/code-agent/context'
import { resolveCodeModelSelection } from '@/lib/code-agent/model-selection'
import { isProvisionalRepositoryForSession } from '@/lib/code-agent/provisional-repository'
import { parseCodeBranch, parseCodeMode, type CodeChatMessage } from '@/lib/code-agent/request'
import {
  getGitHubConnectionStatusForUser,
  getGitHubCredentialForUser,
} from '@/lib/github-connection'
import { repoMeta } from '@/lib/github'
import type { Memory } from '@/lib/memory-data'
import { loadSharedUserMemoryContext } from '@/lib/memory/shared-context'
import { createAdminClient } from '@/lib/supabase/admin'
import type { SupabaseClient } from '@/lib/supabase/types'
import { JobRuntimeError } from '../errors'
import type { JobExecutionContext } from '../worker'
import { loadAgentMessageHistory } from './agent-message-history'
import { persistCodeTaskMode, provisionalAgentInput } from './agent-plan-input'
import { agentExecutionBackend } from '@/lib/agent/execution-policy'
import { currentWorkspaceBranch } from './agent-workspace-branch'

type AgentIdentity = {
  userId: string
  taskId: string
  wireRepo: string
  sessionId: string
  responseId: string
  userMessageId: string
}

type AgentTaskRow = {
  id: string
  repo: string | null
  goal: string | null
  status: string
  agent_branch: string | null
  branch?: string
}

type AgentSourceRow = { id: string; created_at: string }
type AgentCredential = { token: string; login: string }
type AgentGitHubIdentity = { login: string }

export type LoadedAgentJob = {
  client: SupabaseClient
  userId: string
  taskId: string
  repo: string | null
  sessionId: string
  responseId: string
  userMessageId: string
  messages: CodeChatMessage[]
  token: string
  login: string
  defaultBranch: string | null
  repoIsPrivate: boolean
  memories: string[]
  userMemories: Memory[]
  memoryEnabled: boolean
  sensitiveMemoryEnabled: boolean
  mode: CodeAgentMode
  workspaceReady: boolean
  selection: ChatModelSelection
  usingBalance: boolean
}

export type AgentInputDependencies = {
  client: () => SupabaseClient
  credential: (context: JobExecutionContext, userId: string) => Promise<AgentCredential>
  githubIdentity: (context: JobExecutionContext, userId: string) => Promise<AgentGitHubIdentity>
  prepareWorkspace: typeof prepareWorkspace
  loadSharedMemoryContext: typeof loadSharedUserMemoryContext
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function required(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) {
    throw new JobRuntimeError('JOB_INVALID_INPUT', `Missing ${name}`)
  }
  return value
}

function adminClient(): SupabaseClient {
  try {
    const client = createAdminClient()
    if (client) return client
  } catch (error) {
    throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Database authority is unavailable', {
      cause: error,
    })
  }
  throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Database authority is unavailable')
}

function identity(context: JobExecutionContext): AgentIdentity {
  return {
    userId: context.job.principal.id,
    taskId: required(context.job.subject.taskId, 'taskId'),
    wireRepo: required(context.job.subject.repo, 'repo'),
    sessionId: required(context.job.subject.sessionId, 'sessionId'),
    responseId: required(context.job.subject.responseId, 'responseId'),
    userMessageId: required(context.job.subject.userMessageId, 'userMessageId'),
  }
}

async function selectedModel(
  context: JobExecutionContext,
  client: SupabaseClient,
  userId: string,
): Promise<{ selection: ChatModelSelection; usingBalance: boolean }> {
  const payload = object(context.job.input)
  const modelId = required(payload.modelId, 'modelId')
  const endpointId = payload.endpointId === undefined ? undefined : required(payload.endpointId, 'endpointId')
  const reasoningEffort = typeof payload.reasoningEffort === 'string'
    ? payload.reasoningEffort
    : undefined
  let selection: ChatModelSelection
  try {
    selection = await resolveCodeModelSelection({
      modelId,
      endpointId,
      reasoningEffort,
      supabase: client as unknown as SupabaseServer,
      userId,
      allowPremium: true,
    })
  } catch (error) {
    if (error instanceof ChatModelSelectionError) {
      throw new JobRuntimeError(
        error.status >= 500 ? 'JOB_DEPENDENCY_UNAVAILABLE' : 'JOB_CONFLICT',
        error.message,
        { class: 'policy', retryable: error.status >= 500, cause: error },
      )
    }
    throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Agent model policy is unavailable', {
      class: 'policy', cause: error,
    })
  }
  if (payload.accessClass !== selection.accessClass) {
    throw new JobRuntimeError('JOB_CONFLICT', 'Agent model policy changed after enqueue')
  }
  return {
    selection,
    usingBalance: object(payload.admission).funding === 'balance' || payload.usingBalance === true,
  }
}

async function memoriesFor(
  client: SupabaseClient,
  value: AgentIdentity,
  enabled: boolean,
): Promise<string[]> {
  if (!enabled) return []
  const result = await client.from('code_memories').select('content').eq('user_id', value.userId)
    .eq('repo', value.wireRepo).order('created_at')
  if (result.error) throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Agent context is unavailable')
  return (result.data ?? []).flatMap(row => typeof row.content === 'string' ? [row.content] : [])
}

async function authorityRows(
  client: SupabaseClient,
  value: AgentIdentity,
  loadMemories: boolean,
  loadSharedMemoryContext: typeof loadSharedUserMemoryContext,
) {
  const [taskResult, sourceResult, memories, userMemoryContext] = await Promise.all([
    client.from('agent_tasks').select('id,repo,goal,status,agent_branch,branch')
      .eq('id', value.taskId).eq('user_id', value.userId).maybeSingle(),
    client.from('code_messages').select('id,created_at').eq('id', value.userMessageId)
      .eq('session_id', value.sessionId).eq('user_id', value.userId).eq('role', 'user').maybeSingle(),
    memoriesFor(client, value, loadMemories),
    loadSharedMemoryContext(client, value.userId),
  ])
  if (taskResult.error || sourceResult.error) {
    throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Agent context is unavailable')
  }
  const task = taskResult.data as AgentTaskRow | null
  const source = sourceResult.data as AgentSourceRow | null
  if (!task || task.repo !== value.wireRepo || !source) {
    throw new JobRuntimeError('JOB_CONFLICT', 'Agent authority mismatch')
  }
  return { task, source, memories, userMemoryContext }
}

async function githubCredential(context: JobExecutionContext, userId: string): Promise<AgentCredential> {
  const credential = await getGitHubCredentialForUser(userId, {
    actorType: 'worker',
    actorId: context.fence.workerId,
    purpose: 'agent.job',
    requestId: context.job.id,
  })
  if (!credential) {
    throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'GitHub credential is unavailable', {
      class: 'policy',
      retryable: false,
    })
  }
  return credential
}

async function githubIdentity(
  context: JobExecutionContext,
  userId: string,
): Promise<AgentGitHubIdentity> {
  const connection = await getGitHubConnectionStatusForUser(userId, {
    actorType: 'worker',
    actorId: context.fence.workerId,
    purpose: 'agent.plan',
    requestId: context.job.id,
  })
  if (!connection) {
    throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'GitHub connection is unavailable', {
      class: 'policy',
      retryable: false,
    })
  }
  return { login: connection.login }
}

async function existingWorkspaceReady(
  client: SupabaseClient,
  value: AgentIdentity,
): Promise<boolean> {
  const detail = await getTaskDetail(client, value.userId, value.taskId).catch(() => null)
  return Boolean(detail && 'workspace' in detail && detail.workspace?.path
    && (detail.workspace.status === 'ready' || detail.workspace.status === 'dirty')
    && existsSync(detail.workspace.path))
}

async function ensureWorkspace(
  context: JobExecutionContext,
  client: SupabaseClient,
  value: AgentIdentity,
  task: AgentTaskRow,
  credential: AgentCredential,
  defaultBranch: string,
  createInitialAuthority: boolean,
): Promise<string | null> {
  if (await existingWorkspaceReady(client, value)) return task.agent_branch
  const created = await createWorkspaceForTask(
    client,
    value.userId,
    value.taskId,
    credential.token,
    value.wireRepo,
    typeof task.goal === 'string' ? task.goal : '代码任务',
    defaultBranch,
    createInitialAuthority,
  )
  const ready = Boolean(created && !('error' in created) && created.path && existsSync(created.path))
  if (!ready) throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Workspace creation failed')
  context.signal.throwIfAborted()
  return created && !('error' in created) ? created.agentBranch : null
}

async function prepareWorkspace(
  context: JobExecutionContext,
  client: SupabaseClient,
  value: AgentIdentity,
  task: AgentTaskRow,
  credential: AgentCredential,
) {
  if (!isValidGitHubRepository(value.wireRepo)) {
    throw new JobRuntimeError('JOB_INVALID_INPUT', 'Agent repository is invalid')
  }
  const metadata = await repoMeta(credential.token, value.wireRepo)
  if (!metadata) {
    throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Repository metadata is unavailable', {
      class: 'provider',
    })
  }
  const authority = await readWorkspaceAuthority(client, value.userId, value.taskId)
  const baseBranch = parseCodeBranch(object(context.job.input).branch)
    ?? (task.agent_branch ? task.branch : undefined) ?? metadata.defaultBranch
  if (task.agent_branch && task.branch && task.branch !== baseBranch) {
    throw new JobRuntimeError('JOB_CONFLICT', 'Existing workspace is bound to a different base branch; create a new task')
  }
  const binding = await client.from('agent_tasks').update({ branch: baseBranch, mode: 'auto' })
    .eq('id', value.taskId).eq('user_id', value.userId)
  if (binding.error) throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Cannot persist workspace base branch')
  const createdBranch = await ensureWorkspace(
    context, client, value, task, credential, baseBranch, !authority,
  )
  const rawBranch = await currentWorkspaceBranch(context, value, task.agent_branch, createdBranch)
  const branch = await bindWorkspaceBranch(context, client, rawBranch)
  if (authority) {
    await restoreWorkspaceAuthority({
      client,
      userId: value.userId,
      taskId: value.taskId,
      token: credential.token,
      branch,
      authority,
      signal: context.signal,
    })
  } else {
    await advanceWorkspaceAuthority(context, client, value.userId, value.taskId, 'initial-worker-hydration')
  }
  return { defaultBranch: baseBranch, repoIsPrivate: metadata.isPrivate }
}

const DEFAULT_DEPENDENCIES: AgentInputDependencies = {
  client: adminClient,
  credential: githubCredential,
  githubIdentity,
  prepareWorkspace,
  loadSharedMemoryContext: loadSharedUserMemoryContext,
}

export async function loadAgentJob(
  context: JobExecutionContext,
  overrides: Partial<AgentInputDependencies> = {},
): Promise<LoadedAgentJob> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides }
  const client = dependencies.client()
  const value = identity(context)
  parseCodeMode(object(context.job.input).mode)
  if (agentExecutionBackend() !== 'isolated') throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Cloud Code requires an isolated cloud execution backend', { class: 'policy', retryable: false })
  const model = await selectedModel(context, client, value.userId)
  const provisional = isProvisionalRepositoryForSession(value.wireRepo, value.sessionId)
  const mode = codeAgentMode(!provisional)
  const { task, source, memories, userMemoryContext } = await authorityRows(
    client, value, mode === 'workspace', dependencies.loadSharedMemoryContext,
  )
  if (object(context.job.input).mode !== undefined) await persistCodeTaskMode(client, value, 'code')
  const messages = await loadAgentMessageHistory(client, value, source, mode)
  const memory = {
    userMemories: userMemoryContext.memories, memoryEnabled: userMemoryContext.memoryEnabled,
    sensitiveMemoryEnabled: userMemoryContext.sensitiveMemoryEnabled,
  }
  if (provisional) {
    const connection = await dependencies.githubIdentity(context, value.userId)
    return {
      ...provisionalAgentInput({ client, identity: value, login: connection.login,
        messages, memory }),
      ...model,
    }
  }
  const credential = await dependencies.credential(context, value.userId)
  const workspace = await dependencies.prepareWorkspace(context, client, value, task, credential)
  return {
    client,
    ...value,
    repo: value.wireRepo,
    messages,
    token: credential.token,
    login: credential.login,
    memories,
    userMemories: userMemoryContext.memories,
    memoryEnabled: userMemoryContext.memoryEnabled,
    sensitiveMemoryEnabled: userMemoryContext.sensitiveMemoryEnabled,
    mode,
    workspaceReady: true,
    ...workspace,
    ...model,
  }
}
