import type { SupabaseServer } from '@/lib/api/guard'
import { log } from '@/lib/logger'
import type { TablesInsert } from '@/lib/supabase/types'
import {
  chunkMessages,
  embed,
  embeddingEnabled,
  estimateTokens,
  hash,
  normalizeMessage,
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

export type HistoryRetrievalMode = 'light' | 'balanced' | 'deep'

type RetrievalConfig = {
  anchorLimit: number
  before: number
  after: number
  semantic: boolean
  keyword: boolean
}

const RETRIEVAL_CONFIG: Record<HistoryRetrievalMode, RetrievalConfig> = {
  light: { anchorLimit: 3, before: 2, after: 3, semantic: false, keyword: false },
  balanced: { anchorLimit: 6, before: 3, after: 4, semantic: true, keyword: true },
  deep: { anchorLimit: 10, before: 5, after: 6, semantic: true, keyword: true },
}


type ConversationRow = {
  id: string
  title: string | null
  project_id: string | null
  updated_at?: string | null
}

function inScope(hitProjectId: string | null | undefined, projectId: string | null | undefined): boolean {
  return projectId ? hitProjectId === projectId : !hitProjectId
}

async function scopedConversationIds(supabase: SupabaseServer, userId: string, projectId: string | null | undefined, currentConversationId: string | null, limit = 240): Promise<string[]> {
  let req = supabase.from('conversations').select('id').eq('user_id', userId)
  req = projectId ? req.eq('project_id', projectId) : req.is('project_id', null)
  if (currentConversationId) req = req.neq('id', currentConversationId)
  const { data, error } = await req.order('updated_at', { ascending: false }).limit(limit)
  if (error || !data) return []
  return (data as Array<{ id?: unknown }>).map(row => row.id).filter((id): id is string => typeof id === 'string')
}

export async function ensureConversationIndexed(supabase: SupabaseServer | null, userId: string | null, conversationId: string | null, signal?: AbortSignal): Promise<void> {
  if (!supabase || !userId || !conversationId) return

  try {
    const [{ data: conversation }, { data: messages, error: msgError }] = await Promise.all([
      supabase.from('conversations').select('id, title, project_id, updated_at').eq('id', conversationId).eq('user_id', userId).maybeSingle(),
      supabase.from('messages').select('id, role, content, images, created_at').eq('conversation_id', conversationId).eq('user_id', userId).order('created_at', { ascending: true }),
    ])
    if (msgError || !conversation) return

    const rows = (messages ?? []) as MessageRow[]
    const chunks = chunkMessages(rows)
    if (!chunks.length) return

    const hashes = chunks.map(c => hash(c.content))
    const { data: existing } = await supabase.from('conversation_chunks').select('content_hash').eq('conversation_id', conversationId).in('content_hash', hashes)

    const seen = new Set(((existing ?? []) as Array<{ content_hash?: unknown }>)
      .map(row => row.content_hash)
      .filter((value): value is string => typeof value === 'string'))
    const pending = chunks.filter(c => !seen.has(hash(c.content))).slice(0, 24)
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

function renderAnchoredContext(anchor: MessageRow, rows: MessageRow[], config: RetrievalConfig): string {
  const anchorIndex = rows.findIndex(m => m.id === anchor.id)
  const safeAnchorIndex = anchorIndex >= 0 ? anchorIndex : 0
  const start = Math.max(0, safeAnchorIndex - config.before)
  const end = Math.min(rows.length, safeAnchorIndex + config.after + 1)
  const windowRows = rows.slice(start, end)

  return [
    '【用户锚点｜只以这条用户消息作为事实核心】',
    normalizeMessage(anchor),
    '',
    `【上下文窗口｜前 ${config.before} 条 + 后 ${config.after} 条】`,
    windowRows.map(normalizeMessage).join('\n\n'),
  ].join('\n').trim()
}

function buildAnchoredHit(args: {
  anchor: MessageRow
  rows: MessageRow[]
  conversation: ConversationRow
  config: RetrievalConfig
  similarity: number
}): RetrievalHit | null {
  const { anchor, rows, conversation, config, similarity } = args
  const anchorIndex = rows.findIndex(m => m.id === anchor.id)
  if (anchorIndex < 0 || anchor.role !== 'user' || !(anchor.content ?? '').trim()) return null
  const start = Math.max(0, anchorIndex - config.before)
  const end = Math.min(rows.length, anchorIndex + config.after + 1)
  const windowRows = rows.slice(start, end)

  return {
    id: `user-anchor-${anchor.id}`,
    conversation_id: conversation.id,
    conversation_title: conversation.title ?? null,
    project_id: conversation.project_id ?? null,
    message_start_id: windowRows[0]?.id ?? anchor.id,
    message_end_id: windowRows[windowRows.length - 1]?.id ?? anchor.id,
    content: renderAnchoredContext(anchor, rows, config),
    similarity,
    created_at: anchor.created_at ?? null,
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
  const seenConversations = new Map<string, { conversation: ConversationRow; rows: MessageRow[] } | null>()

  for (const hit of hits) {
    if (!inScope(hit.project_id, projectId)) continue

    let cached = seenConversations.get(hit.conversation_id)
    if (cached === undefined) {
      const [{ data: conversation }, { data: threadRows }] = await Promise.all([
        supabase.from('conversations').select('id, title, project_id').eq('id', hit.conversation_id).eq('user_id', userId).maybeSingle(),
        supabase.from('messages').select('id, role, content, images, created_at, conversation_id').eq('conversation_id', hit.conversation_id).eq('user_id', userId).order('created_at', { ascending: true }).limit(260),
      ])
      const conv = conversation as ConversationRow | null
      cached = conv && inScope(conv.project_id, projectId)
        ? { conversation: conv, rows: (threadRows ?? []) as MessageRow[] }
        : null
      seenConversations.set(hit.conversation_id, cached)
    }
    if (!cached) continue

    const startIndex = hit.message_start_id ? cached.rows.findIndex(m => m.id === hit.message_start_id) : -1
    const endIndex = hit.message_end_id ? cached.rows.findIndex(m => m.id === hit.message_end_id) : -1
    const rangeStart = startIndex >= 0 ? startIndex : 0
    const rangeEnd = endIndex >= rangeStart ? endIndex + 1 : cached.rows.length
    const candidates = cached.rows
      .slice(rangeStart, rangeEnd)
      .filter(m => m.role === 'user' && !!(m.content ?? '').trim())
      .map((m, index) => ({ row: m, score: keywordScore(query, m.content ?? '') - index * 0.001 }))
      .sort((a, b) => b.score - a.score)

    const anchor = candidates[0]?.row
    if (!anchor) continue
    const anchored = buildAnchoredHit({
      anchor,
      rows: cached.rows,
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

async function retrieveUserAnchoredContexts(supabase: SupabaseServer, userId: string, projectId: string | null | undefined, conversationId: string | null, query: string, config: RetrievalConfig): Promise<RetrievalHit[]> {
  const scopedIds = await scopedConversationIds(supabase, userId, projectId, conversationId, 260)
  if (!scopedIds.length) return []

  const { data: anchorsRaw, error } = await supabase
    .from('messages')
    .select('id, role, content, images, created_at, conversation_id')
    .eq('user_id', userId)
    .eq('role', 'user')
    .in('conversation_id', scopedIds)
    .order('created_at', { ascending: false })
    .limit(180)

  if (error || !anchorsRaw?.length) return []

  const anchors = (anchorsRaw as MessageRow[])
    .filter(m => !!m.conversation_id && !!(m.content ?? '').trim())
    .map((m, index) => ({ row: m, relevance: keywordScore(query, m.content ?? ''), index }))
    .filter(item => item.relevance > 0)
    .map(item => ({ row: item.row, score: item.relevance - item.index * 0.002 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, config.anchorLimit)

  const convIds = Array.from(new Set(anchors.map(a => a.row.conversation_id).filter(Boolean))) as string[]
  const { data: conversations } = convIds.length
    ? await supabase.from('conversations').select('id, title, project_id').eq('user_id', userId).in('id', convIds)
    : { data: [] as ConversationRow[] }
  const convMap = new Map(((conversations ?? []) as ConversationRow[]).map(conversation => [conversation.id, conversation]))

  const hits: RetrievalHit[] = []
  for (const [index, anchor] of anchors.entries()) {
    const cid = anchor.row.conversation_id
    if (!cid) continue

    const { data: threadRows } = await supabase
      .from('messages')
      .select('id, role, content, images, created_at, conversation_id')
      .eq('user_id', userId)
      .eq('conversation_id', cid)
      .order('created_at', { ascending: true })
      .limit(260)

    const rows = (threadRows ?? []) as MessageRow[]
    const anchorIndex = rows.findIndex(m => m.id === anchor.row.id)
    if (anchorIndex < 0) continue

    const conv = convMap.get(cid)
    if (!conv || !inScope(conv.project_id, projectId)) continue

    const hit = buildAnchoredHit({
      anchor: anchor.row,
      rows,
      conversation: conv,
      config,
      similarity: anchor.score - index * 0.01,
    })
    if (hit) hits.push(hit)
  }

  return hits
}

export async function retrieveHistoryContext(opts: {
  supabase: SupabaseServer | null
  userId: string | null
  conversationId: string | null
  projectId?: string | null
  query: string
  mode: HistoryRetrievalMode
  signal?: AbortSignal
}): Promise<string> {
  const { supabase, userId, conversationId, projectId, query, mode, signal } = opts
  if (!supabase || !userId || !query.trim()) return ''

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

    return renderHits(hits, projectId, mode)
  } catch (e) {
    if (signal?.aborted) throw e
    log.warn('activeRetrieval', 'Retrieval skipped', e)
    return ''
  }
}
