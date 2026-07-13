import type { Dispatch, SetStateAction } from 'react'
import type { Conversation } from '@/lib/chat-data'
import type { ClientGenerationPatch, ClientGenerationState } from '@/lib/generation-client'
import { requestClientGenerationCancellation } from './generation-job-actions'
import { recordAcknowledgedGenerationTerminal } from './generation-terminal-registry'

export async function cancelActiveGeneration(options: {
  conversationId: string
  generation: ClientGenerationState | undefined
  setConversations: Dispatch<SetStateAction<Conversation[]>>
  markGeneration: (conversationId: string, patch: ClientGenerationPatch) => void
}) {
  const { conversationId, generation, setConversations } = options
  if (generation?.status !== 'running'
    || !generation.generationId
    || !generation.assistantMessageId) return
  try {
    const terminal = await requestClientGenerationCancellation(generation.generationId)
    recordAcknowledgedGenerationTerminal(generation.generationId, terminal)
    // The response stream remains the rendering authority and observes this
    // same terminal CAS with its already accumulated content.
    console.info('[mychat/generation] cancellation acknowledged', {
      conversationId,
      generationId: generation.generationId,
      assistantMessageId: generation.assistantMessageId,
      winner: terminal.status,
    })
  } catch (error) {
    setConversations(previous => previous.map(conversation => conversation.id !== conversationId
      ? conversation
      : {
        ...conversation,
        messages: conversation.messages.map(message => message.id !== generation.assistantMessageId
          ? message
          : { ...message, outputWarning: '取消请求失败，任务仍在继续生成，请稍后重试。' }),
      }))
    console.warn('[mychat/generation] cancellation failed', {
      conversationId,
      generationId: generation.generationId,
      error: error instanceof Error ? error.name : 'unknown',
    })
  }
}
