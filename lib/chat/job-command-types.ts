import type { DurableChatRequestBody } from '@/lib/llm/chat-request'
import type { ModelOutputKind } from '@/lib/model-endpoints'
import type { SearchMode } from './request-context'

export type EnqueueChatJobInput = {
  body: DurableChatRequestBody
  userId: string
  isAnonymous: boolean
  usingBalance: boolean
  searchMode: SearchMode
  outputKind: ModelOutputKind
  requestId: string
  requestedAt?: string
}
