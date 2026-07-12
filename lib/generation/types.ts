export type GenerationStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export type GenerationEvent = {
  generationId: string
  conversationId: string
  assistantMessageId: string
  sequence: number
  type: 'text' | 'thinking' | 'status' | 'error' | 'done'
  delta?: string
  status: GenerationStatus
  content?: string
  thinking?: string
  error?: string
}

export type GenerationRecord = {
  id: string
  userId: string
  conversationId: string
  assistantMessageId: string
  status: GenerationStatus
  content: string
  thinking: string
  sequence: number
  error?: string
  createdAt: number
  updatedAt: number
}
