import type { DurableChatRequestBody } from '@/lib/llm/chat-request'
import type { ModelAccessClass } from '@/lib/model-catalog'
import type { ModelOutputKind } from '@/lib/model-endpoints'
import type { SearchMode } from './request-context'

export type EnqueueChatJobInput = {
  body: DurableChatRequestBody
  userId: string
  isAnonymous: boolean
  usingBalance: boolean
  searchMode: SearchMode
  outputKind: ModelOutputKind
  accessClass: ModelAccessClass | 'legacy'
  requestId: string
  requestedAt?: string
}
