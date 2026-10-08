import { repoMeta } from '@/lib/github'
import { parseCodeBranch, type CodeChatMessage } from '@/lib/code-agent/request'
import { JobRuntimeError } from '../errors'
import type { JobExecutionContext } from '../worker'
import type { LoadedAgentJob } from './agent-input'

type PlanIdentity = Pick<LoadedAgentJob, 'userId' | 'taskId' | 'sessionId' | 'responseId' | 'userMessageId'> & { wireRepo: string }
type PlanMemory = Pick<LoadedAgentJob, 'userMemories' | 'memoryEnabled' | 'sensitiveMemoryEnabled'>

/** Plan loads repository metadata through GitHub only; it never clones or hydrates a workspace. */
export async function loadReadOnlyPlan(input: {
  context: JobExecutionContext
  client: LoadedAgentJob['client']
  identity: PlanIdentity
  credential: { token: string; login: string }
  agentBranch: string | null
  messages: CodeChatMessage[]
  memories: string[]
  memory: PlanMemory
}): Promise<Omit<LoadedAgentJob, 'selection' | 'usingBalance'>> {
  const { context, client, identity, credential } = input
  const metadata = await repoMeta(credential.token, identity.wireRepo)
  if (!metadata) throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Repository metadata is unavailable')
  const payload = context.job.input && typeof context.job.input === 'object' && !Array.isArray(context.job.input) ? context.job.input : {}
  const branch = parseCodeBranch(payload.branch) ?? metadata.defaultBranch
  if (!input.agentBranch) {
    const binding = await client.from('agent_tasks').update({ branch })
      .eq('id', identity.taskId).eq('user_id', identity.userId)
    if (binding.error) throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Cannot persist Plan branch')
  }
  return {
    client, ...identity, repo: identity.wireRepo, messages: input.messages,
    token: credential.token, login: credential.login, defaultBranch: branch,
    repoIsPrivate: metadata.isPrivate, memories: input.memories, ...input.memory,
    mode: 'plan', readOnlyPlan: true, workspaceReady: false,
  }
}

export async function persistCodeTaskMode(client: LoadedAgentJob['client'], identity: PlanIdentity,
  mode: 'plan' | 'code' | undefined) {
  if (!mode) return
  const binding = await client.from('agent_tasks').update({ mode: mode === 'plan' ? 'plan' : 'auto' })
    .eq('id', identity.taskId).eq('user_id', identity.userId)
  if (binding.error) throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Cannot persist task mode')
}

export function provisionalPlanInput(input: {
  client: LoadedAgentJob['client']
  identity: PlanIdentity
  login: string
  messages: CodeChatMessage[]
  memory: PlanMemory
  readOnlyPlan: boolean
}): Omit<LoadedAgentJob, 'selection' | 'usingBalance'> {
  return {
    client: input.client, ...input.identity, repo: null,
    messages: input.messages, token: '', login: input.login,
    defaultBranch: null, repoIsPrivate: false, memories: [], ...input.memory,
    mode: 'plan', readOnlyPlan: input.readOnlyPlan, workspaceReady: false,
  }
}
