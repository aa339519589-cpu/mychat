import type { SupabaseServer } from '@/lib/api/guard'
import {
  ensureConversationIndexed,
  latestUserQuery,
  retrieveHistoryContext,
} from '@/lib/llm/active-retrieval'
import {
  prepareConversationSummary,
  RECENT_CONTEXT_MESSAGES,
} from '@/lib/llm/conversation-summary'
import type { RawMsg } from '@/lib/llm/types'
import { historyRetrievalModeForTier } from './request-context'

export { RECENT_CONTEXT_MESSAGES }

export async function prepareChatHistory(options: {
  supabase: SupabaseServer | null
  userId: string | null
  conversationId?: string
  messages: RawMsg[]
  projectId?: string | null
  tier: string
  historyRetrievalEnabled: boolean
  customEndpoint: boolean
  signal?: AbortSignal
}): Promise<{ conversationId: string | null; renderedContext: string }> {
  const summary = await prepareConversationSummary({
    supabase: options.supabase,
    userId: options.userId,
    explicitConversationId: options.conversationId,
    messages: options.messages,
    signal: options.signal,
    allowCompaction: !options.customEndpoint,
  })

  if (!options.historyRetrievalEnabled) {
    return { conversationId: summary.conversationId, renderedContext: summary.renderedSummary }
  }

  if (!options.customEndpoint) {
    await ensureConversationIndexed(
      options.supabase,
      options.userId,
      summary.conversationId,
      options.signal,
    )
  }
  const historyContext = await retrieveHistoryContext({
    supabase: options.supabase,
    userId: options.userId,
    conversationId: summary.conversationId,
    projectId: options.projectId,
    query: latestUserQuery(options.messages),
    mode: options.customEndpoint ? 'light' : historyRetrievalModeForTier(options.tier),
    signal: options.signal,
  })
  return {
    conversationId: summary.conversationId,
    renderedContext: summary.renderedSummary + historyContext,
  }
}
