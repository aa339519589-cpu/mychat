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
import { createAdminClient } from '@/lib/supabase/admin'

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

type ChatHistoryDependencies = {
  prepareSummary: typeof prepareConversationSummary
  retrieveHistory: typeof retrieveHistoryWithSources
}

type TimedHistory = {
  value: Awaited<ReturnType<typeof retrieveHistoryWithSources>>
  elapsedMs: number
}

function startParallelHistory(
  options: { deferIndexing?: boolean; conversationId?: string },
  crossConversation: boolean,
  retrieve: (id: string | null) => ReturnType<typeof retrieveHistoryWithSources>,
): Promise<TimedHistory | null> {
  if (!options.deferIndexing || !options.conversationId || !crossConversation) {
    return Promise.resolve(null)
  }
  return timedHistory(retrieve, options.conversationId)
}

async function timedHistory(
  retrieve: (id: string | null) => ReturnType<typeof retrieveHistoryWithSources>,
  conversationId: string | null,
): Promise<TimedHistory> {
  const startedAt = Date.now()
  const value = await retrieve(conversationId)
  return { value, elapsedMs: Date.now() - startedAt }
}

async function prepareChatHistoryUnbounded(options: {
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
}, dependencies: ChatHistoryDependencies = {
  prepareSummary: prepareConversationSummary,
  retrieveHistory: retrieveHistoryWithSources,
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
  const summaryPromise = dependencies.prepareSummary({
    supabase: options.supabase,
    userId: options.userId,
    explicitConversationId: options.conversationId,
    messages: options.messages,
    signal: options.signal,
    allowCompaction: !options.customEndpoint,
  })
  const retrieve = (id: string | null) => dependencies.retrieveHistory({
    supabase: options.supabase,
    userId: options.userId,
    conversationId: id,
    projectId: options.projectId,
    query,
    mode: options.customEndpoint ? 'balanced' : historyRetrievalModeForTier(options.tier),
    signal: options.signal,
  })
  const crossConversation = needsCrossConversationHistory(latestUserText(options.messages))
  // Worker admission supplies the current conversation ID and defers indexing.
  // Cross-conversation lookup does not depend on its summary, so do both reads
  // together while still waiting for both before assembling model context.
  const [summary, parallelHistory] = await Promise.all([
    summaryPromise.then(value => ({ ...value, elapsedMs: Date.now() - summaryStartedAt })),
    startParallelHistory(options, crossConversation, retrieve),
  ])
  const summaryMs = summary.elapsedMs

  if (!options.deferIndexing) await refreshChatHistoryIndex({
    supabase: options.supabase, userId: options.userId,
    conversationId: summary.conversationId, signal: options.signal,
  })
  if (!crossConversation) {
    log.info('jobs', 'Chat history preparation timing', {
      conversationId: summary.conversationId, summaryMs, retrievalMs: 0, socialOnly: true,
    })
    return { conversationId: summary.conversationId, renderedContext: summary.renderedSummary }
  }
  const historyResult = parallelHistory ?? await timedHistory(retrieve, summary.conversationId)
  const history = historyResult.value
  log.info('jobs', 'Chat history preparation timing', {
    conversationId: summary.conversationId, summaryMs,
    retrievalMs: historyResult.elapsedMs, socialOnly: false,
  })
  return {
    conversationId: summary.conversationId,
    renderedContext: summary.renderedSummary + history.renderedContext,
    query,
    sources: history.sources,
  }
}

type HistoryOptions = Parameters<typeof prepareChatHistoryUnbounded>[0] & { deadlineMs?: number }
type HistoryResult = Awaited<ReturnType<typeof prepareChatHistoryUnbounded>> & { degraded?: boolean }

/** Optional cross-conversation I/O cannot indefinitely block the main model.
 * The scoped client aborts every underlying read, not merely its observer. */
export async function prepareChatHistory(options: HistoryOptions,
  dependencies: ChatHistoryDependencies = { prepareSummary: prepareConversationSummary, retrieveHistory: retrieveHistoryWithSources },
): Promise<HistoryResult> {
  if (!options.historyRetrievalEnabled) return prepareChatHistoryUnbounded(options, dependencies)
  options.signal?.throwIfAborted()
  const controller = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
  const deadlineMs = options.deadlineMs ?? (historyRetrievalModeForTier(options.tier) === 'light' ? 1_500 : 3_000)
  let completedSummary = ''
  let completedHistory: Awaited<ReturnType<typeof retrieveHistoryWithSources>> = { renderedContext: '', sources: [] }
  const observed: ChatHistoryDependencies = {
    prepareSummary: async input => {
      const result = await dependencies.prepareSummary(input)
      completedSummary = result.renderedSummary
      return result
    },
    retrieveHistory: async input => {
      const result = await dependencies.retrieveHistory(input)
      completedHistory = result
      return result
    },
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const scoped = createAdminClient(signal)
    const work = prepareChatHistoryUnbounded({ ...options, supabase: scoped as SupabaseServer | null ?? options.supabase, signal }, observed)
    return await Promise.race([work, new Promise<HistoryResult>((resolve, reject) => {
      timer = setTimeout(() => {
        if (options.signal?.aborted) reject(options.signal.reason)
        else {
          log.warn('jobs', 'Optional history retrieval deadline reached', { conversationId: options.conversationId, deadlineMs })
          resolve({ conversationId: options.conversationId ?? null,
            renderedContext: completedSummary + completedHistory.renderedContext,
            sources: completedHistory.sources, degraded: true })
        }
        controller.abort(new Error('Optional history retrieval deadline'))
      }, deadlineMs)
    })])
  } finally { if (timer) clearTimeout(timer) }
}
