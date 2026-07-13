import type { Message, MessageGenerationTerminal } from '@/lib/chat-data'
import { generationTerminalWarning } from '@/lib/generation-message'
import { readCachedMessages, writeCachedMessages } from './message-cache'

export type TerminalCacheSnapshot = {
  status: MessageGenerationTerminal['status']
  content: string
  thinking: string
  media: Message['media']
  sequence: number
  error: string | null
  generationId: string
}

export function upsertGenerationTerminalMessage(
  cached: Message[],
  messageId: string,
  terminal: TerminalCacheSnapshot,
): Message[] {
  const generation: MessageGenerationTerminal = {
    id: terminal.generationId,
    status: terminal.status,
    sequence: terminal.sequence,
    error: terminal.error,
  }
  const canonical: Message = {
    id: messageId,
    role: 'assistant',
    time: '',
    content: terminal.content,
    thinking: terminal.thinking || undefined,
    media: terminal.status === 'completed' && terminal.media?.length ? terminal.media : undefined,
    isError: terminal.status === 'failed' ? true : undefined,
    outputWarning: generationTerminalWarning(generation),
    generation,
  }
  let found = false
  const messages = cached.map(message => {
    if (message.id !== messageId) return message
    found = true
    return {
    ...message,
      ...canonical,
      time: message.time,
      ts: message.ts,
    }
  })
  return found ? messages : [...messages, canonical]
}

export async function cacheGenerationTerminal(
  conversationId: string,
  messageId: string,
  terminal: TerminalCacheSnapshot,
): Promise<void> {
  const cached = await readCachedMessages(conversationId)
  await writeCachedMessages(
    conversationId,
    upsertGenerationTerminalMessage(cached, messageId, terminal),
  )
}
