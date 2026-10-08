import { runAgentLoop, type AgentLoopOpts } from '@/lib/llm/agent-loop'

/** Provider-independent contract; hosted/private Codex Cloud is not assumed. */
export interface AgentDriver {
  readonly id: string
  run(options: AgentLoopOpts): ReturnType<typeof runAgentLoop>
}

export const modelToolCallingDriver: AgentDriver = {
  id: 'model-tool-calling',
  run: runAgentLoop,
}
