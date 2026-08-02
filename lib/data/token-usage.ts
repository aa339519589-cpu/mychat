import { normalizeTokenUsage, type TokenUsage } from '@/lib/token-usage'
import { isRecord } from '@/lib/unknown-value'
import { readCachedMessages, writeCachedMessages } from './message-cache'

export async function persistOwnerTokenUsage(
  conversationId: string,
  messageId: string,
  generationId: string,
): Promise<TokenUsage | null> {
  const response = await fetch('/api/messages/token-usage', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ conversationId, messageId, generationId }),
  })
  if (!response.ok) return null
  const payload: unknown = await response.json().catch(() => null)
  const tokenUsage = normalizeTokenUsage(isRecord(payload) ? payload.tokenUsage : null)
  if (!tokenUsage) return null
  const cached = await readCachedMessages(conversationId)
  if (cached.length) {
    await writeCachedMessages(
      conversationId,
      cached.map(message => message.id === messageId
        ? { ...message, tokenUsage }
        : message),
    )
  }
  return tokenUsage
}
