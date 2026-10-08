import type { CodeChatMessage } from '@/lib/code-agent/request'
import { JobRuntimeError } from '../errors'
import type { LoadedAgentJob } from './agent-input'

type PlanIdentity = Pick<LoadedAgentJob, 'userId' | 'taskId' | 'sessionId' | 'responseId' | 'userMessageId'> & { wireRepo: string }
type PlanMemory = Pick<LoadedAgentJob, 'userMemories' | 'memoryEnabled' | 'sensitiveMemoryEnabled'>

export async function persistCodeTaskMode(client: LoadedAgentJob['client'], identity: PlanIdentity,
  mode: 'code' | undefined) {
  if (!mode) return
  const binding = await client.from('agent_tasks').update({ mode: 'auto' })
    .eq('id', identity.taskId).eq('user_id', identity.userId)
  if (binding.error) throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Cannot persist task mode')
}

export function provisionalAgentInput(input: {
  client: LoadedAgentJob['client']
  identity: PlanIdentity
  login: string
  messages: CodeChatMessage[]
  memory: PlanMemory
}): Omit<LoadedAgentJob, 'selection' | 'usingBalance'> {
  return {
    client: input.client, ...input.identity, repo: null,
    messages: input.messages, token: '', login: input.login,
    defaultBranch: null, repoIsPrivate: false, memories: [], ...input.memory,
    mode: 'plan', workspaceReady: false,
  }
}
