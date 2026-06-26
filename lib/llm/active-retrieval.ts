import { createHash } from 'crypto'
import type { SupabaseServer } from '@/lib/api/guard'
import type { RawMsg } from '@/lib/llm/types'
import { log } from '@/lib/logger'

const CHUNK_MESSAGE_COUNT = 8
const CHUNK_OVERLAP = 2
const MAX_CHUNK_CHARS = 4200
const RETRIEVAL_TOP_K = 12
const INJECT_TOP_K = 8
const INJECT_CHAR_BUDGET = 18_000
const DEFAULT_SIMILARITY_THRESHOLD = 0.24
const FORCE_SIMILARITY_THRESHOLD = 0.08
const USER_ANCHOR_LIMIT = 6
const USER_ANCHOR_CONTEXT_BEFORE = 2
const USER_ANCHOR_CONTEXT_AFTER = 5

const HISTORY_RETRIEVAL_HINTS = [
  '之前', '上次', '以前', '还记得', '记不记得', '我们定', '我们说', '我们聊', '刚才', '那个方案', '历史', '旧聊天', '老对话', '前面',
  '其他聊天', '别的聊天', '别的对话', '去看其他', '去看别的', '查其他', '跨聊天', '日程', '安排', '今晚', '今天晚上', '明天', '待办',
  '午饭', '中午', '吃了什么', '吃什么', '干什么', '做什么', '记忆', '检索', '找一下', '翻一下',
  'last time', 'previously', 'earlier', 'remember', 'we discussed', 'we decided', 'other chats', 'past chats', 'schedule', 'tonight',
]

type MessageRow = {
  id: string
  role: 'user' | 'assistant'
  content: string | null
  images?: unknown
  created_at?: string | null
  conversation_id?: string | null
}

type ConversationRow = {
  id: string
  title: string | null
  project_id: string | null
  updated_at?: string | null
}

type RetrievalHit = {
  id: string
  conversation_id: string
  conversation_title: string | null
  project_id: string | null
  message_start_id: string | null
  message_end_id: string | null
  content: string
  similarity: number
  created_at: string | null
}

function embeddingConfig() {
  return {
    apiKey: process.env.EMBEDDING_API_KEY || process.env.OPENAI_API_KEY || '',
    baseUrl: (process.env.EMBEDDING_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    model: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
    dimensions: process.env.EMBEDDING_DIMENSIONS ? Number(process.env.EMBEDDING_DIMENSIONS) : undefined,
  }
}

function embeddingEnabled(): boolean {
  const cfg = embeddingConfig()
  return !!cfg.apiKey && !!cfg.model
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3)
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function imageSummaryFromStoredImages(images: unknown): string {
  if (!images || Array.isArray(images)) return ''
  const summary = (images as any)?.image_summary
  return typeof summary === 'string' ? summary.trim() : ''
}

function normalizeMessage(m: MessageRow): string {
  const speaker = m.role === 'user' ? '用户' : '模型'
  const content = (m.content ?? '').trim()
  const imageSummary = imageSummaryFromStoredImages(m.images)
  const body = [content, imageSummary ? `图片摘要：${imageSummary}` : ''].filter(Boolean).join('\n')
  return `【${speaker}】${body || '（空）'}`
}

function chunkMessages(messages: MessageRow[]) {
  const chunks: { start: MessageRow; end: MessageRow; content: string }[] = []
  if (!messages.length) return chunks

  for (let i = 0; i < messages.length; i += Math.max(1, CHUNK_MESSAGE_COUNT - CHUNK_OVERLAP)) {
    const part: MessageRow[] = []
    let chars = 0
    for (let j = i; j < messages.length && part.length < CHUNK_MESSAGE_COUNT; j++) {
      const text = normalizeMessage(messages[j])
      if (part.length > 0 && chars + text.length > MAX_CHUNK_CHARS) break
      part.push(messages[j])
      chars += text.length
    }
    if (part.length < 2) continue
    const content = part.map(normalizeMessage).join('\n\n').trim()
    if (!content) continue
    chunks.push({ start: part[0], end: part[part.length - 1], content })
  }

  return chunks
}

async function embed(input: string): Promise<number[] | null> {
  const cfg = embeddingConfig()
  if (!cfg.apiKey) return null

  try {
    const body: Record<string, unknown> = { model: cfg.model, input }
    if (Number.isFinite(cfg.dimensions)) body.dimensions = cfg.dimensions

    const res = await fetch(`${cfg.baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      log.warn('activeRetrieval', 'Embedding request failed', { status: res.status, body: await res.text().catch(() => '') })
      return null
    }
    const json = await res.json()
    const vector = json?.data?.[0]?.embedding
    return Array.isArray(vector) ? vector : null
  } catch (e) {
    log.warn('activeRetrieval', 'Embedding skipped', e)
    return null
  }
}

export function shouldForceHistoryRetrieval(text: string): boolean {
  const q = text.toLowerCase()
  return HISTORY_RETRIEVAL_HINTS.some(h => q.includes(h.toLowerCase()))
}

function rawMessageText(m: RawMsg): string {
  const anyMsg = m as any
  if (typeof anyMsg?.content === 'string') return anyMsg.content.trim()
  if (Array.isArray(anyMsg?.content)) {
    return anyMsg.content.map((x: any) => typeof x?.text === 'string' ? x.text : '').join('\n').trim()
  }
  return ''
}

export function latestUserQuery(messages: RawMsg[]): string {
  let lastUser = ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as any
    if (m?.role !== 'user') continue
    const text = rawMessageText(messages[i])
    if (text) { lastUser = text; break }
  }

  const recent = messages
    .slice(-8)
    .map((m: any) => {
      const text = rawMessageText(m).slice(0, 900)
      if (!text) return ''
      return `${m.role === 'assistant' ? '模型' : '用户'}：${text}`
    })
    .filter(Boolean)
    .join('\n')

  return [
    lastUser ? `【当前用户问题】${lastUser}` : '',
    recent ? `【最近几轮上下文】\n${recent}` : '',
  ].filter(Boolean).join('\n\n')
}

export async function ensureConversationIndexed(supabase: SupabaseServer | null, userId: string | null, conversationId: string | null): Promise<void> {
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

    const seen = new Set((existing ?? []).map((r: any) => r.content_hash as string))
    const pending = chunks.filter(c => !seen.has(hash(c.content))).slice(0, 24)
    if (!pending.length) return

    const conv = conversation as ConversationRow
    const rowsToInsert = []
    for (const chunk of pending) {
      const vector = embeddingEnabled() ? await embed(chunk.content) : null
      if (!vector && embeddingEnabled()) continue
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

    if (!rowsToInsert.length) return
    const { error } = await supabase.from('conversation_chunks').upsert(rowsToInsert, { onConflict: 'user_id,content_hash' })
    if (error) log.warn('activeRetrieval', 'Failed to save chunks', error)
  } catch (e) {
    log.warn('activeRetrieval', 'Indexing skipped', e)
  }
}

export async function backfillUserConversationIndex(supabase: SupabaseServer | null, userId: string | null, limit = 40): Promise<{ indexed: number; embeddingEnabled: boolean }> {
  if (!supabase || !userId) return { indexed: 0, embeddingEnabled: embeddingEnabled() }

  const { data } = await supabase.from('conversations').select('id').eq('user_id', userId).order('updated_at', { ascending: false }).limit(limit)

  let indexed = 0
  for (const c of data ?? []) {
    await ensureConversationIndexed(supabase, userId, (c as any).id)
    indexed++
  }
  return { indexed, embeddingEnabled: embeddingEnabled() }
}

function queryTerms(query: string): string[] {
  const base = query.toLowerCase()
    .replace(/[()&|!:*'"<>【】\[\]{}]/g, ' ')
    .split(/[\s,，。.!?！？、/\\|：:]+/)
    .map(w => w.trim())
    .filter(w => w.length >= 2)

  const extra: string[] = []
  if (query.includes('中午') || query.includes('午饭') || query.includes('午餐')) extra.push('中午', '午饭', '午餐', '吃')
  if (query.includes('吃')) extra.push('吃', '饭', '吃了')
  if (query.includes('今晚') || query.includes('今天晚上')) extra.push('今晚', '今天晚上', '晚上')
  if (query.includes('干什么') || query.includes('做什么')) extra.push('干什么', '做什么', '安排')

  return Array.from(new Set([...base, ...extra])).slice(0, 28)
}

function keywordScore(query: string, content: string): number {
  const words = queryTerms(query)
  if (!words.length) return 0
  const lower = content.toLowerCase()
  return words.reduce((acc, w) => acc + (lower.includes(w.toLowerCase()) ? 0.05 : 0), 0)
}

function textSearchQuery(query: string): string {
  return queryTerms(query).slice(0, 12).join(' | ')
}

function dedupeHits(hits: RetrievalHit[]): RetrievalHit[] {
  const seen = new Set<string>()
  const out: RetrievalHit[] = []
  for (const hit of hits) {
    const key = `${hit.conversation_id}:${hit.message_start_id}:${hit.message_end_id}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(hit)
  }
  return out
}

function renderHits(hits: RetrievalHit[]): string {
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
  return `\n\n【主动检索到的历史对话片段】\n下面是系统从历史聊天中临时检索到的相关原文片段。回答历史问题时，必须以【用户】说过的话作为事实来源；【模型】说过的话只能当上下文，不得当成用户事实。若片段里只有模型提问、没有用户回答，就必须说没有找到用户自己的明确记录。不要说你看不到其他聊天。\n\n${parts.join('\n\n---\n\n')}`
}

async function retrieveBySemanticChunks(supabase: SupabaseServer, userId: string, projectId: string | null | undefined, conversationId: string | null, query: string, force: boolean): Promise<RetrievalHit[]> {
  const queryEmbedding = embeddingEnabled() ? await embed(query) : null
  if (!queryEmbedding) return []

  const { data, error } = await supabase.rpc('match_conversation_chunks', {
    query_embedding: queryEmbedding,
    match_user_id: userId,
    match_project_id: null,
    match_count: RETRIEVAL_TOP_K,
    similarity_threshold: force ? FORCE_SIMILARITY_THRESHOLD : DEFAULT_SIMILARITY_THRESHOLD,
  })
  if (error || !data) return []

  return (data as RetrievalHit[]).map(hit => ({
    ...hit,
    similarity: hit.similarity + keywordScore(query, hit.content) + (projectId && hit.project_id === projectId ? 0.04 : 0) + (conversationId && hit.conversation_id === conversationId ? 0.01 : 0),
  }))
}

async function retrieveByTextSearch(supabase: SupabaseServer, userId: string, projectId: string | null | undefined, query: string, force: boolean): Promise<RetrievalHit[]> {
  const fts = textSearchQuery(query)
  if (!fts) return []
  const { data, error } = await supabase.rpc('match_conversation_chunks_text', {
    query_text: fts,
    match_user_id: userId,
    match_project_id: null,
    match_count: RETRIEVAL_TOP_K,
  })
  if (error || !data) return []

  const hits = (data as RetrievalHit[])
    .map(hit => ({ ...hit, similarity: hit.similarity + keywordScore(query, hit.content) + (projectId && hit.project_id === projectId ? 0.04 : 0) }))
    .sort((a, b) => b.similarity - a.similarity)

  if (!force && hits[0] && hits[0].similarity < 0.08) return []
  return hits.slice(0, INJECT_TOP_K)
}

async function retrieveRecentChunks(supabase: SupabaseServer, userId: string, projectId: string | null | undefined, conversationId: string | null, query: string): Promise<RetrievalHit[]> {
  let req = supabase
    .from('conversation_chunks')
    .select('id, conversation_id, conversation_title, project_id, message_start_id, message_end_id, content, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(RETRIEVAL_TOP_K)

  if (conversationId) req = req.neq('conversation_id', conversationId)

  const { data, error } = await req
  if (error || !data) return []
  return (data as any[]).map((hit, index) => ({
    id: hit.id,
    conversation_id: hit.conversation_id,
    conversation_title: hit.conversation_title,
    project_id: hit.project_id,
    message_start_id: hit.message_start_id,
    message_end_id: hit.message_end_id,
    content: hit.content,
    similarity: 0.12 - index * 0.004 + keywordScore(query, hit.content) + (projectId && hit.project_id === projectId ? 0.04 : 0),
    created_at: hit.created_at,
  }))
}

async function retrieveUserAnchoredContexts(supabase: SupabaseServer, userId: string, projectId: string | null | undefined, conversationId: string | null, query: string): Promise<RetrievalHit[]> {
  let anchorReq = supabase
    .from('messages')
    .select('id, role, content, images, created_at, conversation_id')
    .eq('user_id', userId)
    .eq('role', 'user')
    .order('created_at', { ascending: false })
    .limit(180)

  if (conversationId) anchorReq = anchorReq.neq('conversation_id', conversationId)

  const { data: anchorsRaw, error } = await anchorReq
  if (error || !anchorsRaw?.length) return []

  const anchors = (anchorsRaw as MessageRow[])
    .filter(m => !!m.conversation_id && !!(m.content ?? '').trim())
    .map((m, index) => ({ row: m, score: 1.2 + keywordScore(query, m.content ?? '') - index * 0.002 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, USER_ANCHOR_LIMIT)

  const convIds = Array.from(new Set(anchors.map(a => a.row.conversation_id).filter(Boolean)))
  const { data: conversations } = convIds.length
    ? await supabase.from('conversations').select('id, title, project_id').eq('user_id', userId).in('id', convIds)
    : { data: [] as any[] }
  const convMap = new Map((conversations ?? []).map((c: any) => [c.id, c as ConversationRow]))

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
      .limit(240)

    const rows = (threadRows ?? []) as MessageRow[]
    const anchorIndex = rows.findIndex(m => m.id === anchor.row.id)
    if (anchorIndex < 0) continue

    const start = Math.max(0, anchorIndex - USER_ANCHOR_CONTEXT_BEFORE)
    const end = Math.min(rows.length, anchorIndex + USER_ANCHOR_CONTEXT_AFTER + 1)
    const windowRows = rows.slice(start, end)
    const conv = convMap.get(cid)
    const content = [
      '【用户锚点｜只以这条用户消息作为事实核心】',
      normalizeMessage(anchor.row),
      '',
      `【上下文窗口｜前 ${USER_ANCHOR_CONTEXT_BEFORE} 条 + 后 ${USER_ANCHOR_CONTEXT_AFTER} 条】`,
      windowRows.map(normalizeMessage).join('\n\n'),
    ].join('\n').trim()

    hits.push({
      id: `user-anchor-${anchor.row.id}`,
      conversation_id: cid,
      conversation_title: conv?.title ?? null,
      project_id: conv?.project_id ?? null,
      message_start_id: windowRows[0]?.id ?? anchor.row.id,
      message_end_id: windowRows[windowRows.length - 1]?.id ?? anchor.row.id,
      content,
      similarity: anchor.score + (projectId && conv?.project_id === projectId ? 0.04 : 0) - index * 0.01,
      created_at: anchor.row.created_at ?? null,
    })
  }

  return hits
}

export async function retrieveHistoryContext(opts: {
  supabase: SupabaseServer | null
  userId: string | null
  conversationId: string | null
  projectId?: string | null
  query: string
}): Promise<string> {
  const { supabase, userId, conversationId, projectId, query } = opts
  if (!supabase || !userId || !query.trim()) return ''

  const force = shouldForceHistoryRetrieval(query)
  try {
    const allHits: RetrievalHit[] = []

    if (force) {
      allHits.push(...await retrieveUserAnchoredContexts(supabase, userId, projectId, conversationId, query))
    }

    allHits.push(...await retrieveBySemanticChunks(supabase, userId, projectId, conversationId, query, force))
    allHits.push(...await retrieveByTextSearch(supabase, userId, projectId, query, force))

    if (force || allHits.length === 0) {
      allHits.push(...await retrieveRecentChunks(supabase, userId, projectId, conversationId, query))
      if (!force) allHits.push(...await retrieveUserAnchoredContexts(supabase, userId, projectId, conversationId, query))
    }

    const hits = dedupeHits(allHits)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, INJECT_TOP_K)

    if (!force && (!hits[0] || hits[0].similarity < DEFAULT_SIMILARITY_THRESHOLD)) return ''
    return renderHits(hits)
  } catch (e) {
    log.warn('activeRetrieval', 'Retrieval skipped', e)
    return ''
  }
}
