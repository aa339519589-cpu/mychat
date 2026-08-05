import type { Dispatch, SetStateAction } from 'react'
import type { Conversation } from '@/lib/chat-data'
import {
  applyConversationGenerationSnapshot,
  toClientGenerationStatus,
  toGenerationTerminalSnapshot,
  type ClientGenerationPatch,
  type ConversationGenerationSnapshot,
} from '@/lib/generation-client'
import { cacheGenerationTerminal, persistOwnerTokenUsage } from '@/lib/data'

export type ConversationSetter = Dispatch<SetStateAction<Conversation[]>>
export type MarkGeneration = (conversationId: string, patch: ClientGenerationPatch) => void

export function applyGenerationSnapshot(
  setConversations: ConversationSetter,
  conversationId: string,
  snapshot: ConversationGenerationSnapshot,
): void {
  setConversations(previous => applyConversationGenerationSnapshot(previous, conversationId, snapshot))
}

export async function applyGenerationTerminal(options: {
  conversationId: string
  snapshot: ConversationGenerationSnapshot
  showTokenUsage: boolean
  setConversations: ConversationSetter
  markGeneration: MarkGeneration
}): Promise<boolean> {
  const terminal = toGenerationTerminalSnapshot(options.snapshot)
  if (!terminal) return false
  applyGenerationSnapshot(options.setConversations, options.conversationId, options.snapshot)
  options.markGeneration(options.conversationId, {
    status: toClientGenerationStatus(options.snapshot.status),
    generationId: options.snapshot.id,
    assistantMessageId: options.snapshot.assistantMessageId,
    authoritativeTerminal: true,
  })
  void cacheGenerationTerminal(options.conversationId, options.snapshot.assistantMessageId, {
    ...terminal,
    generationId: options.snapshot.id,
  }).catch(() => undefined)
  if (options.showTokenUsage && terminal.status === 'completed' && terminal.tokenUsage) {
    void persistOwnerTokenUsage(
      options.conversationId,
      options.snapshot.assistantMessageId,
      options.snapshot.id,
    ).catch(() => null)
  }
  return true
}

export function markGenerationWarning(
  setConversations: ConversationSetter,
  conversationId: string,
  assistantMessageId: string,
  warning = '生成状态连接已中断；当前内容已保留，重新打开会话可再次同步。',
): void {
  setConversations(previous => previous.map(conversation => conversation.id !== conversationId
    ? conversation
    : {
      ...conversation,
      messages: conversation.messages.map(message => message.id !== assistantMessageId
        ? message
        : { ...message, outputWarning: warning }),
    }))
}
