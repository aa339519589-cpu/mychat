import type { SupabaseServer } from '@/lib/api/guard'
import {
  fetchConversationEdges,
  fetchRowsAroundAnchor,
  messagesForChunkHit,
  type RetrievalConfig,
} from './active-retrieval-context'
import type { MessageRow } from './retrieval-indexing'
import type { RetrievalHit } from './retrieval-ranking'

/** Coalesce equal reads only while they are in flight. Results, including
 * failures, are removed immediately; no account data survives this request. */
function inFlightRead<Key, Value>(read: (key: Key) => PromiseLike<Value>,
  keyOf: (key: Key) => string): (key: Key) => Promise<Value> {
  const pending = new Map<string, Promise<Value>>()
  return input => {
    const key = keyOf(input)
    const existing = pending.get(key)
    if (existing) return existing
    const work = Promise.resolve().then(() => read(input))
    pending.set(key, work)
    void work.then(() => pending.delete(key), () => pending.delete(key))
    return work
  }
}

/** One scope is created per retrieval with one immutable account/client.
 * Semantic and text branches often expand the same hits simultaneously. */
export function createHistoryReadScope(supabase: SupabaseServer, userId: string) {
  const conversation = inFlightRead((id: string) => supabase.from('conversations')
    .select('id, title, project_id').eq('id', id).eq('user_id', userId).maybeSingle(), id => id)
  const edges = inFlightRead((id: string) => fetchConversationEdges(supabase, userId, id), id => id)
  const chunkMessages = inFlightRead((hit: RetrievalHit) => messagesForChunkHit(supabase, userId, hit),
    hit => JSON.stringify([hit.conversation_id, hit.message_start_id, hit.message_end_id]))
  const around = inFlightRead((input: {
    conversationId: string; anchor: MessageRow; config: RetrievalConfig
  }) => fetchRowsAroundAnchor(supabase, userId, input.conversationId, input.anchor, input.config),
  input => JSON.stringify([input.conversationId, input.anchor, input.config.before, input.config.after]))
  return {
    conversation, edges, chunkMessages,
    around: (conversationId: string, anchor: MessageRow, config: RetrievalConfig) =>
      around({ conversationId, anchor, config }),
  }
}

export type HistoryReadScope = ReturnType<typeof createHistoryReadScope>
