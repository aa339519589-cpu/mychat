import type { SupabaseServer } from '@/lib/api/guard'
import {
  ensureConversationIndexed,
  latestUserQuery,
  retrieveHistoryWithSources,
  type RetrievedHistorySource,
} from '@/lib/llm/active-retrieval'
import {
  prepareConversationSummary,
  RECENT_CONTEXT_MESSAGES,
} from '@/lib/llm/conversation-summary'
import type { RawMsg } from '@/lib/llm/types'
import { log } from '@/lib/logger'
import { latestUserText } from '@/lib/llm/retrieval-query'
import { historyRetrievalModeForTier } from './request-context'

export { RECENT_CONTEXT_MESSAGES }

// An isolated greeting/reaction has no factual cross-conversation query. Keep
// the current conversation, memories, system prompt and tools on the normal
// model path; only avoid searching unrelated conversations for this text.
const SOCIAL_ONLY = /^(?:(?:你|您)好(?:呀|啊|呢)?|嗨(?:呀|啊)?|哈[喽啰](?:呀|啊)?|哈{2,}|呵{2,}|嘿{2,}|嗯+|哦+|好(?:的|呀|啊)?|谢谢(?:你|您)?|早安|早上好|下午好|晚上好|晚安|hello|hi|hey|👋|😊|😄|😁|😂)[\s!！?？。.～~]*$/iu

export function needsCrossConversationHistory(query: string): boolean {
  const text = query.trim()
  return text.length > 24 || !SOCIAL_ONLY.test(text)
}

export async function refreshChatHistoryIndex(options: {
  supabase: SupabaseServer | null
  userId: string | null
  conversationId: string | null
  signal?: AbortSignal
  strict?: boolean
  beforeWrite?: () => Promise<void>
}): Promise<void> {
  await ensureConversationIndexed(options.supabase, options.userId, options.conversationId, options.signal, {
    strict: options.strict, beforeWrite: options.beforeWrite,
  })
}

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
  deferIndexing?: boolean
}): Promise<{
  conversationId: string | null
  renderedContext: string
  query?: string
  sources?: RetrievedHistorySource[]
}> {
  if (!options.historyRetrievalEnabled) {
    return {
      conversationId: typeof options.conversationId === 'string' && options.conversationId
        ? options.conversationId
        : null,
      renderedContext: '',
    }
  }

  const query = latestUserQuery(options.messages)
  const summaryStartedAt = Date.now()
  const summary = await prepareConversationSummary({
    supabase: options.supabase,
    userId: options.userId,
    explicitConversationId: options.conversationId,
    messages: options.messages,
    signal: options.signal,
    allowCompaction: !options.customEndpoint,
  })
  const summaryMs = Date.now() - summaryStartedAt

  if (!options.deferIndexing) await refreshChatHistoryIndex({
    supabase: options.supabase, userId: options.userId,
    conversationId: summary.conversationId, signal: options.signal,
  })
  if (!needsCrossConversationHistory(latestUserText(options.messages))) {
    log.info('jobs', 'Chat history preparation timing', {
      conversationId: summary.conversationId, summaryMs, retrievalMs: 0, socialOnly: true,
    })
    return { conversationId: summary.conversationId, renderedContext: summary.renderedSummary }
  }
  const retrievalStartedAt = Date.now()
  const history = await retrieveHistoryWithSources({
    supabase: options.supabase,
    userId: options.userId,
    conversationId: summary.conversationId,
    projectId: options.projectId,
    query,
    mode: options.customEndpoint ? 'balanced' : historyRetrievalModeForTier(options.tier),
    signal: options.signal,
  })
  log.info('jobs', 'Chat history preparation timing', {
    conversationId: summary.conversationId, summaryMs,
    retrievalMs: Date.now() - retrievalStartedAt, socialOnly: false,
  })
  return {
    conversationId: summary.conversationId,
    renderedContext: summary.renderedSummary + history.renderedContext,
    query,
    sources: history.sources,
  }
}
