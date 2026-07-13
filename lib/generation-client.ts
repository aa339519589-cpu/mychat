import type { Conversation, Message, MessageGenerationTerminal } from '@/lib/chat-data'
import { normalizeGeneratedMediaList, type GeneratedMedia } from '@/lib/generated-media'
import { generationTerminalWarning } from '@/lib/generation-message'
import {
  isGenerationTerminalSnapshot,
  type GenerationStatus,
  type GenerationTerminalSnapshot,
} from '@/lib/generation/types'

export type ClientGenerationStatus = 'idle' | 'running' | 'completed' | 'error' | 'cancelled'

export type ClientGenerationState = {
  status: ClientGenerationStatus
  generationId?: string
  assistantMessageId?: string
  conversationId: string
  authoritativeTerminal?: boolean
}

export type ClientGenerationPatch = Partial<ClientGenerationState> & {
  status: ClientGenerationStatus
  begin?: boolean
}

export function reduceClientGenerationState(
  previous: Record<string, ClientGenerationState>,
  conversationId: string,
  patch: ClientGenerationPatch,
): Record<string, ClientGenerationState> {
  const current = previous[conversationId]
  const generationId = patch.generationId ?? current?.generationId
  if (current?.generationId && generationId !== current.generationId && !patch.begin) return previous
  if (current?.authoritativeTerminal
    && current.generationId === generationId
    && patch.authoritativeTerminal !== true) return previous
  return {
    ...previous,
    [conversationId]: {
      conversationId,
      status: patch.status,
      generationId,
      assistantMessageId: patch.assistantMessageId ?? current?.assistantMessageId,
      authoritativeTerminal: patch.authoritativeTerminal === true
        || (!patch.begin && current?.generationId === generationId && current.authoritativeTerminal),
    },
  }
}

export function isRunning(state?: ClientGenerationState | null): boolean {
  return state?.status === 'running'
}

export type ConversationGenerationSnapshot = {
  id: string
  conversationId: string
  assistantMessageId: string
  status: GenerationStatus
  content: string
  thinking: string
  media: GeneratedMedia[]
  sequence: number
  error: string | null
}

function isGenerationStatus(value: unknown): value is GenerationStatus {
  return value === 'queued' || value === 'running' || value === 'completed'
    || value === 'failed' || value === 'cancelled'
}

export function normalizeConversationGenerationSnapshot(
  value: unknown,
): ConversationGenerationSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const snapshot = value as Record<string, unknown>
  if (typeof snapshot.id !== 'string'
    || typeof snapshot.conversationId !== 'string'
    || typeof snapshot.assistantMessageId !== 'string'
    || !isGenerationStatus(snapshot.status)
    || typeof snapshot.content !== 'string'
    || typeof snapshot.thinking !== 'string'
    || !Array.isArray(snapshot.media)
    || !Number.isSafeInteger(snapshot.sequence)
    || Number(snapshot.sequence) < 0
    || (snapshot.error !== null && snapshot.error !== undefined && typeof snapshot.error !== 'string')) {
    return null
  }
  const media = normalizeGeneratedMediaList(snapshot.media)
  if (media.length !== snapshot.media.length) return null
  return {
    id: snapshot.id,
    conversationId: snapshot.conversationId,
    assistantMessageId: snapshot.assistantMessageId,
    status: snapshot.status,
    content: snapshot.content,
    thinking: snapshot.thinking,
    media,
    sequence: Number(snapshot.sequence),
    error: typeof snapshot.error === 'string' ? snapshot.error : null,
  }
}

export function toGenerationTerminalSnapshot(
  snapshot: ConversationGenerationSnapshot,
): GenerationTerminalSnapshot | null {
  const terminal = {
    status: snapshot.status,
    content: snapshot.content,
    thinking: snapshot.thinking,
    media: snapshot.media,
    sequence: snapshot.sequence,
    error: snapshot.error,
  }
  return isGenerationTerminalSnapshot(terminal) ? terminal : null
}

export function toClientGenerationStatus(
  status: GenerationStatus,
): ClientGenerationStatus {
  if (status === 'completed') return 'completed'
  if (status === 'cancelled') return 'cancelled'
  if (status === 'failed') return 'error'
  return 'running'
}

function terminalMetadata(
  snapshot: ConversationGenerationSnapshot,
): MessageGenerationTerminal | undefined {
  if (snapshot.status === 'queued' || snapshot.status === 'running') return undefined
  return {
    id: snapshot.id,
    status: snapshot.status,
    sequence: snapshot.sequence,
    error: snapshot.error,
  }
}

function applySnapshotToMessage(
  message: Message,
  snapshot: ConversationGenerationSnapshot,
): Message {
  const terminal = terminalMetadata(snapshot)
  const previousTerminal = message.generation
  if (previousTerminal && (
    !terminal
    || previousTerminal.id !== terminal.id
    || previousTerminal.sequence > terminal.sequence
  )) return message
  return {
    ...message,
    role: 'assistant',
    content: snapshot.content,
    thinking: snapshot.thinking || undefined,
    media: snapshot.media.length ? snapshot.media : undefined,
    isError: snapshot.status === 'failed' ? true : undefined,
    outputWarning: generationTerminalWarning(terminal),
    generation: terminal,
  }
}

/** Apply a database-authoritative generation snapshot without regressing a newer terminal cache. */
export function applyConversationGenerationSnapshot(
  conversations: Conversation[],
  conversationId: string,
  snapshot: ConversationGenerationSnapshot,
): Conversation[] {
  if (snapshot.conversationId !== conversationId) return conversations
  return conversations.map(conversation => {
    if (conversation.id !== conversationId) return conversation
    let found = false
    const messages = conversation.messages.map(message => {
      if (message.id !== snapshot.assistantMessageId) return message
      found = true
      return applySnapshotToMessage(message, snapshot)
    })
    if (!found) {
      messages.push(applySnapshotToMessage({
        id: snapshot.assistantMessageId,
        role: 'assistant',
        content: '',
        time: '',
      }, snapshot))
    }
    return { ...conversation, messages }
  })
}

export type GenerationStreamText = { content: string; thinking: string }

/**
 * Merge a resume event without applying a delta twice. Local runner events may
 * carry both a complete snapshot and the latest delta, whereas database events
 * carry only the snapshot.
 */
export function mergeGenerationStreamText(
  current: GenerationStreamText,
  event: Record<string, unknown>,
): GenerationStreamText {
  const hasContentSnapshot = typeof event.content === 'string'
  const hasThinkingSnapshot = typeof event.thinking === 'string'
  const content = hasContentSnapshot
    ? event.content as string
    : event.type === 'text' && typeof event.delta === 'string'
      ? current.content + event.delta
      : current.content
  const thinking = hasThinkingSnapshot
    ? event.thinking as string
    : event.type === 'thinking' && typeof event.delta === 'string'
      ? current.thinking + event.delta
      : current.thinking
  return { content, thinking }
}
