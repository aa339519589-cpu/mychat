import type { Dispatch, SetStateAction } from 'react'
import type { Conversation } from '@/lib/chat-data'
import type { ClientGenerationPatch, ClientGenerationState } from '@/lib/generation-client'
import { cacheConversationMessages } from '@/lib/data'
import { requestClientGenerationCancellation } from './generation-job-actions'
import { recordAcknowledgedGenerationTerminal } from './generation-terminal-registry'
import { removePendingChatSubmission } from './pending-chat-submission'

export async function cancelActiveGeneration(options: {
  conversationId: string
  generation: ClientGenerationState | undefined
  setConversations: Dispatch<SetStateAction<Conversation[]>>
  markGeneration: (conversationId: string, patch: ClientGenerationPatch) => void
  controller?: AbortController
}) {
  const { conversationId, generation, setConversations } = options
  if (generation?.status !== 'running'
    || !generation.generationId
    || !generation.assistantMessageId) return
  const pendingRemoved = await removePendingChatSubmission(
    conversationId,
    generation.generationId,
  )
  if (pendingRemoved) {
    options.controller?.abort(new DOMException('Stopped', 'AbortError'))
    setConversations(previous => previous.map(conversation => {
      if (conversation.id !== conversationId) return conversation
      const messages = conversation.messages.filter(message => message.id !== generation.assistantMessageId)
      cacheConversationMessages(conversationId, messages)
      return { ...conversation, messages }
    }))
  }
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
    if (pendingRemoved) {
      options.markGeneration(conversationId, {
        status: 'cancelled',
        generationId: generation.generationId,
        assistantMessageId: generation.assistantMessageId,
      })
      return
    }
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
