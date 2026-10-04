import type { SupabaseServer } from '@/lib/api/guard'
import { log } from '@/lib/logger'
import type { TablesInsert } from '@/lib/supabase/types'
import {
  buildAnchoredHit,
  fetchAllConversationMessages,
  fetchConversationEdges,
  fetchRowsAroundAnchor,
  messagesForChunkHit,
  MESSAGE_FIELDS,
  type ConversationEdges,
  type ConversationRow,
  type RetrievalConfig,
} from '@/lib/llm/active-retrieval-context'
import {
  chunkMessages,
  embed,
  embeddingEnabled,
  estimateTokens,
  hash,
  type MessageRow,
} from '@/lib/llm/retrieval-indexing'
import {
  dedupeHits,
  keywordScore,
  textSearchQuery,
  type RetrievalHit,
} from '@/lib/llm/retrieval-ranking'

export { latestUserQuery } from '@/lib/llm/retrieval-query'

const RETRIEVAL_TOP_K = 12
const INJECT_TOP_K = 8
const INJECT_CHAR_BUDGET = 18_000
const DEFAULT_SIMILARITY_THRESHOLD = 0.24
const FORCE_SIMILARITY_THRESHOLD = 0.08
const HASH_QUERY_BATCH_SIZE = 100

export type HistoryRetrievalMode = 'light' | 'balanced' | 'deep'

const RETRIEVAL_CONFIG: Record<HistoryRetrievalMode, RetrievalConfig> = {
  light: { anchorLimit: 3, before: 2, after: 3, semantic: false, keyword: false },
  balanced: { anchorLimit: 6, before: 3, after: 4, semantic: true, keyword: true },
  deep: { anchorLimit: 10, before: 5, after: 6, semantic: true, keyword: true },
}


function inScope(hitProjectId: string | null | undefined, projectId: string | null | undefined): boolean {
  return projectId ? hitProjectId === projectId : !hitProjectId
}

async function scopedConversationIds(supabase: SupabaseServer, userId: string, projectId: string | null | undefined, currentConversationId: string | null, limit = 240): Promise<string[]> {
  const queryIds = async (ascending: boolean) => {
    let req = supabase.from('conversations').select('id').eq('user_id', userId)
    req = projectId ? req.eq('project_id', projectId) : req.is('project_id', null)
    if (currentConversationId) req = req.neq('id', currentConversationId)
    return req.order('updated_at', { ascending }).limit(Math.ceil(limit / 2))
  }
  const [recent, oldest] = await Promise.all([queryIds(false), queryIds(true)])
  const ids = [
    ...((recent.error ? [] : recent.data ?? []) as Array<{ id?: unknown }>),
    ...((oldest.error ? [] : oldest.data ?? []) as Array<{ id?: unknown }>),
  ].map(row => row.id).filter((id): id is string => typeof id === 'string')
  return Array.from(new Set(ids)).slice(0, limit)
}

export async function ensureConversationIndexed(supabase: SupabaseServer | null, userId: string | null, conversationId: string | null, signal?: AbortSignal): Promise<void> {
  if (!supabase || !userId || !conversationId) return

  try {
    const [{ data: conversation }, messageResult] = await Promise.all([
      supabase.from('conversations').select('id, title, project_id, updated_at').eq('id', conversationId).eq('user_id', userId).maybeSingle(),
      fetchAllConversationMessages(supabase, userId, conversationId),
    ])
    if (messageResult.error || !conversation) return

    const rows = messageResult.rows
    const chunks = chunkMessages(rows)
    if (!chunks.length) return

    const hashes = chunks.map(c => hash(c.content))
    const existingBatches = await Promise.all(Array.from({ length: Math.ceil(hashes.length / HASH_QUERY_BATCH_SIZE) }, (_, index) =>
      supabase.from('conversation_chunks').select('content_hash').eq('conversation_id', conversationId)
        .in('content_hash', hashes.slice(index * HASH_QUERY_BATCH_SIZE, (index + 1) * HASH_QUERY_BATCH_SIZE))))
    const existing = existingBatches.flatMap(result => result.error ? [] : result.data ?? [])

    const seen = new Set(((existing ?? []) as Array<{ content_hash?: unknown }>)
      .map(row => row.content_hash)
      .filter((value): value is string => typeof value === 'string'))
    const pendingChunks = chunks.filter(c => !seen.has(hash(c.content)))
    const pending = pendingChunks.length <= 24
      ? pendingChunks
      : [...pendingChunks.slice(0, 12), ...pendingChunks.slice(-12)]
    if (!pending.length) return

    const conv = conversation as ConversationRow
    const rowsToInsert: TablesInsert<'conversation_chunks'>[] = []
    let cursor = 0
    const workers = Array.from({ length: Math.min(4, pending.length) }, async () => {
      while (cursor < pending.length) {
        const chunk = pending[cursor++]
        const vector = embeddingEnabled() ? await embed(chunk.content, signal) : null
        rowsToInsert.push({
        user_id: userId,
        conversation_id: conversationId,
        project_id: conv.project_id ?? null,
        conversation_title: conv.title ?? null,
        message_start_id: chunk.start.id,
        message_end_id: chunk.end.id,
        content: chunk.content,
        content_hash: hash(chunk.content),
        token_count: estimateTokens(chunk.content),
        embedding: vector,
        })
      }
    })
    await Promise.all(workers)

    if (!rowsToInsert.length) return
    const { error } = await supabase.from('conversation_chunks').upsert(rowsToInsert, { onConflict: 'conversation_id,content_hash' })
    if (error) log.warn('activeRetrieval', 'Failed to save chunks', error)
  } catch (e) {
    if (signal?.aborted) throw e
    log.warn('activeRetrieval', 'Indexing skipped', e)
  }
}

function renderHits(hits: RetrievalHit[], projectId: string | null | undefined, mode: HistoryRetrievalMode): string {
  if (!hits.length) return ''
  const parts: string[] = []
  let used = 0

  for (const hit of hits) {
    const title = hit.conversation_title?.trim() || '未命名聊天'
    const content = hit.content.trim()
    const block = `【历史片段｜${title}｜匹配度 ${hit.similarity.toFixed(2)}】\n${content}`
    if (used + block.length > INJECT_CHAR_BUDGET) break
    used += block.length
    parts.push(block)
  }

  if (!parts.length) return ''
  const scopeText = projectId ? '当前 Project 的独立历史池' : '普通 Chat 的独立历史池'
  return `\n\n【主动检索到的历史对话片段｜${scopeText}｜${mode}】\n下面片段只来自${scopeText}，禁止混用其他 Project、Code 或普通 Chat 的历史。回答历史问题时，必须以【用户】说过的话作为事实来源；【模型】说过的话只能当上下文，不得当成用户事实。若片段里只有模型提问、没有用户回答，就必须说没有找到用户自己的明确记录。不要说你看不到其他聊天。\n\n${parts.join('\n\n---\n\n')}`
}

async function retrieveAnchorsFromChunkHits(supabase: SupabaseServer, userId: string, projectId: string | null | undefined, query: string, config: RetrievalConfig, hits: RetrievalHit[]): Promise<RetrievalHit[]> {
  const out: RetrievalHit[] = []
  const seenConversations = new Map<string, { conversation: ConversationRow; edges: ConversationEdges } | null>()

  for (const hit of hits) {
    if (!inScope(hit.project_id, projectId)) continue

    let cached = seenConversations.get(hit.conversation_id)
    if (cached === undefined) {
      const [{ data: conversation }, edges] = await Promise.all([
        supabase.from('conversations').select('id, title, project_id').eq('id', hit.conversation_id).eq('user_id', userId).maybeSingle(),
        fetchConversationEdges(supabase, userId, hit.conversation_id),
      ])
      const conv = conversation as ConversationRow | null
      cached = conv && inScope(conv.project_id, projectId)
        ? { conversation: conv, edges }
        : null
      seenConversations.set(hit.conversation_id, cached)
    }
    if (!cached) continue

    const chunkRows = await messagesForChunkHit(supabase, userId, hit)
    if (!chunkRows.length) continue
    const candidates = chunkRows
      .filter(m => m.role === 'user' && !!(m.content ?? '').trim())
      .map((m, index) => ({ row: m, score: keywordScore(query, m.content ?? '') - index * 0.001 }))
      .sort((a, b) => b.score - a.score)

    const anchor = candidates[0]?.row
    if (!anchor) continue
    const rows = await fetchRowsAroundAnchor(supabase, userId, hit.conversation_id, anchor, config)
    const anchored = buildAnchoredHit({
      anchor,
      rows,
      edges: cached.edges,
      conversation: cached.conversation,
      config,
      similarity: hit.similarity + keywordScore(query, anchor.content ?? ''),
    })
    if (anchored) out.push(anchored)
  }

  return out
}

async function retrieveBySemanticChunks(supabase: SupabaseServer, userId: string, projectId: string | null | undefined, conversationId: string | null, query: string, mode: HistoryRetrievalMode, config: RetrievalConfig, signal?: AbortSignal): Promise<RetrievalHit[]> {
  const queryEmbedding = embeddingEnabled() ? await embed(query, signal) : null
  if (!queryEmbedding) return []

  const { data, error } = await supabase.rpc('match_conversation_chunks', {
    query_embedding: queryEmbedding,
    match_user_id: userId,
    match_project_id: projectId ?? null,
    match_count: mode === 'deep' ? 24 : RETRIEVAL_TOP_K,
    similarity_threshold: mode === 'deep' ? FORCE_SIMILARITY_THRESHOLD : DEFAULT_SIMILARITY_THRESHOLD,
  })
  if (error || !data) return []

  const hits = (data as RetrievalHit[])
    .filter(hit => inScope(hit.project_id, projectId) && (!conversationId || hit.conversation_id !== conversationId))
    .map(hit => ({
      ...hit,
      similarity: hit.similarity + keywordScore(query, hit.content),
    }))
  return retrieveAnchorsFromChunkHits(supabase, userId, projectId, query, config, hits)
}

async function retrieveByTextSearch(supabase: SupabaseServer, userId: string, projectId: string | null | undefined, conversationId: string | null, query: string, mode: HistoryRetrievalMode, config: RetrievalConfig): Promise<RetrievalHit[]> {
  const fts = textSearchQuery(query)
  if (!fts) return []
  const { data, error } = await supabase.rpc('match_conversation_chunks_text', {
    query_text: fts,
    match_user_id: userId,
    match_project_id: projectId ?? null,
    match_count: mode === 'deep' ? 24 : RETRIEVAL_TOP_K,
  })
  if (error || !data) return []

  const hits = (data as RetrievalHit[])
    .filter(hit => inScope(hit.project_id, projectId) && (!conversationId || hit.conversation_id !== conversationId))
    .map(hit => ({ ...hit, similarity: hit.similarity + keywordScore(query, hit.content) }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, INJECT_TOP_K)
  return retrieveAnchorsFromChunkHits(supabase, userId, projectId, query, config, hits)
}

async function findUserAnchors(supabase: SupabaseServer, userId: string, projectId: string | null | undefined, conversationId: string | null, query: string, limit: number): Promise<Array<{ row: MessageRow; score: number }>> {
  const scopedIds = await scopedConversationIds(supabase, userId, projectId, conversationId, 260)
  if (!scopedIds.length) return []

  const queryAnchors = (ascending: boolean) => supabase.from('messages')
    .select(MESSAGE_FIELDS).eq('user_id', userId).eq('role', 'user').in('conversation_id', scopedIds)
    .order('created_at', { ascending }).limit(180)
  const [recent, oldest] = await Promise.all([queryAnchors(false), queryAnchors(true)])
  const anchorsRaw = [
    ...((recent.error ? [] : recent.data ?? []) as MessageRow[]),
    ...((oldest.error ? [] : oldest.data ?? []) as MessageRow[]),
  ]
  if (!anchorsRaw.length) return []

  return Array.from(new Map(anchorsRaw.map(row => [row.id, row])).values())
    .filter(m => !!m.conversation_id && !!(m.content ?? '').trim())
    .map((m, index) => ({ row: m, relevance: keywordScore(query, m.content ?? ''), index }))
    .filter(item => item.relevance > 0)
    .map(item => ({ row: item.row, score: item.relevance - item.index * 0.002 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

async function retrieveUserAnchoredContexts(supabase: SupabaseServer, userId: string, projectId: string | null | undefined, conversationId: string | null, query: string, config: RetrievalConfig): Promise<RetrievalHit[]> {
  const anchors = await findUserAnchors(supabase, userId, projectId, conversationId, query, config.anchorLimit)
  if (!anchors.length) return []

  const convIds = Array.from(new Set(anchors.map(a => a.row.conversation_id).filter(Boolean))) as string[]
  const { data: conversations } = convIds.length
    ? await supabase.from('conversations').select('id, title, project_id').eq('user_id', userId).in('id', convIds)
    : { data: [] as ConversationRow[] }
  const convMap = new Map(((conversations ?? []) as ConversationRow[]).map(conversation => [conversation.id, conversation]))

  const hits: RetrievalHit[] = []
  const edgesByConversation = new Map<string, ConversationEdges>()
  for (const [index, anchor] of anchors.entries()) {
    const cid = anchor.row.conversation_id
    if (!cid) continue

    const [rows, edges] = await Promise.all([
      fetchRowsAroundAnchor(supabase, userId, cid, anchor.row, config),
      edgesByConversation.get(cid) ? Promise.resolve(edgesByConversation.get(cid)!) : fetchConversationEdges(supabase, userId, cid),
    ])
    edgesByConversation.set(cid, edges)
    const anchorIndex = rows.findIndex(m => m.id === anchor.row.id)
    if (anchorIndex < 0) continue

    const conv = convMap.get(cid)
    if (!conv || !inScope(conv.project_id, projectId)) continue

    const hit = buildAnchoredHit({
      anchor: anchor.row,
      rows,
      edges,
      conversation: conv,
      config,
      similarity: anchor.score - index * 0.01,
    })
    if (hit) hits.push(hit)
  }

  return hits
}

export type RetrievedHistorySource = {
  conversationId: string
  conversationTitle: string | null
  messageStartId: string | null
  snippet: string
  createdAt: string | null
}

function historySourcePreview(content: string): string {
  const section = (heading: string) => {
    const start = content.indexOf(heading)
    if (start < 0) return ''
    const bodyStart = content.indexOf('\n', start)
    if (bodyStart < 0) return ''
    const nextHeading = content.indexOf('\n【', bodyStart + 1)
    return content.slice(bodyStart + 1, nextHeading < 0 ? undefined : nextHeading)
      .replace(/【[^】]*】/g, ' ').replace(/\s+/g, ' ').trim()
  }
  const opening = section('【对话开篇')
  const anchor = section('【用户锚点')
  const recent = section('【最近对话')
  if (!opening && !anchor && !recent) return content.replace(/【[^】]*】/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 360)
  const parts = [
    opening ? `开篇：${opening.slice(0, 86)}` : '',
    anchor ? `匹配：${anchor.slice(0, 130)}` : '',
    recent ? `最近：${recent.slice(0, 86)}` : '',
  ].filter(Boolean)
  return parts.join(' · ').slice(0, 360)
}

export async function retrieveHistoryWithSources(opts: {
  supabase: SupabaseServer | null
  userId: string | null
  conversationId: string | null
  projectId?: string | null
  query: string
  mode: HistoryRetrievalMode
  signal?: AbortSignal
}): Promise<{ renderedContext: string; sources: RetrievedHistorySource[] }> {
  const { supabase, userId, conversationId, projectId, query, mode, signal } = opts
  if (!supabase || !userId || !query.trim()) return { renderedContext: '', sources: [] }

  const config = RETRIEVAL_CONFIG[mode] ?? RETRIEVAL_CONFIG.balanced
  try {
    const allHits: RetrievalHit[] = []

    allHits.push(...await retrieveUserAnchoredContexts(supabase, userId, projectId, conversationId, query, config))

    if (config.semantic) allHits.push(...await retrieveBySemanticChunks(supabase, userId, projectId, conversationId, query, mode, config, signal))
    if (config.keyword) allHits.push(...await retrieveByTextSearch(supabase, userId, projectId, conversationId, query, mode, config))

    const hits = dedupeHits(allHits)
      .filter(hit => inScope(hit.project_id, projectId))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, INJECT_TOP_K)

    return {
      renderedContext: renderHits(hits, projectId, mode),
      sources: hits.map(hit => ({
        conversationId: hit.conversation_id,
        conversationTitle: hit.conversation_title,
        messageStartId: hit.message_start_id,
        snippet: historySourcePreview(hit.content),
        createdAt: hit.created_at,
      })),
    }
  } catch (e) {
    if (signal?.aborted) throw e
    log.warn('activeRetrieval', 'Retrieval skipped', e)
    return { renderedContext: '', sources: [] }
  }
}

export async function retrieveHistoryContext(opts: Parameters<typeof retrieveHistoryWithSources>[0]): Promise<string> {
  return (await retrieveHistoryWithSources(opts)).renderedContext
}
