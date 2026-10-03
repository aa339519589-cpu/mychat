export type ChatGPTPlanHistoryMessageInput = {
  id: string
  role: 'user' | 'assistant'
  content: string
  thinking?: string
  images: string[]
  createdAt: string
}

export type ChatGPTPlanHistoryTurnInput = {
  conversationId: string
  createConversation: boolean
  title: string
  projectId: string | null
  userMessage: ChatGPTPlanHistoryMessageInput
  assistantMessage: ChatGPTPlanHistoryMessageInput
  regeneration: {
    operation: 'replace-assistant' | 'replace-from-user'
    expectedTailMessageID: string
    targetAssistantMessageID: string | null
  } | null
}

export type ChatGPTPlanHistoryPersistResult =
  | { kind: 'persisted' }
  | { kind: 'not_found' }
  | { kind: 'conflict' }
  | { kind: 'unavailable'; code?: string }
