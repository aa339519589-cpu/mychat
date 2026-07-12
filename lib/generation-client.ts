export type ClientGenerationStatus = 'idle' | 'running' | 'completed' | 'error' | 'cancelled'

export type ClientGenerationState = {
  status: ClientGenerationStatus
  generationId?: string
  assistantMessageId?: string
  conversationId: string
}

export function isRunning(state?: ClientGenerationState | null): boolean {
  return state?.status === 'running'
}
