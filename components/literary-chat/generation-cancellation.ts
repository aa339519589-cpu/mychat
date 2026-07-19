import type { Dispatch, SetStateAction } from 'react'
import type { Conversation } from '@/lib/chat-data'
import { toClientGenerationStatus, type ClientGenerationPatch, type ClientGenerationState } from '@/lib/generation-client'
import { requestClientGenerationCancellation } from './generation-job-actions'
import { recordAcknowledgedGenerationTerminal } from './generation-terminal-registry'

export async function cancelActiveGeneration(options: {
  conversationId: string
  generation: ClientGenerationState | undefined
  setConversations: Dispatch<SetStateAction<Conversation[]>>
  markGeneration: (conversationId: string, patch: ClientGenerationPatch) => void
}) {
  const { conversationId, generation, setConversations, markGeneration } = options
  if (generation?.status !== 'running'
    || !generation.generationId
    || !generation.assistantMessageId) return

  // Give immediate tactile/UI feedback on the first tap. The durable cancel
  // request still runs below and remains the source of truth.
  markGeneration(conversationId, {
    status: 'cancelled',
    generationId: generation.generationId,
    assistantMessageId: generation.assistantMessageId,
  })
  setConversations(previous => previous.map(conversation => conversation.id !== conversationId
    ? conversation
    : {
      ...conversation,
      messages: conversation.messages.map(message => message.id !== generation.assistantMessageId
        ? message
        : { ...message, outputWarning: '已停止生成' }),
    }))

  try {
    const terminal = await requestClientGenerationCancellation(generation.generationId)
    recordAcknowledgedGenerationTerminal(generation.generationId, terminal)
    markGeneration(conversationId, {
      status: toClientGenerationStatus(terminal.status),
      generationId: generation.generationId,
      assistantMessageId: generation.assistantMessageId,
      authoritativeTerminal: true,
    })
    // The response stream remains the rendering authority and observes this
    // same terminal CAS with its already accumulated content.
    console.info('[mychat/generation] cancellation acknowledged', {
      conversationId,
      generationId: generation.generationId,
      assistantMessageId: generation.assistantMessageId,
      winner: terminal.status,
    })
  } catch (error) {
    markGeneration(conversationId, {
      status: 'running',
      generationId: generation.generationId,
      assistantMessageId: generation.assistantMessageId,
    })
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