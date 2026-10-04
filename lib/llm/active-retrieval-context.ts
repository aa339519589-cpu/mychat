import type { SupabaseServer } from '@/lib/api/guard'
import { normalizeMessage, type MessageRow } from '@/lib/llm/retrieval-indexing'
import type { RetrievalHit } from '@/lib/llm/retrieval-ranking'

export const MESSAGE_FIELDS = 'id, seq, role, content, images, created_at, conversation_id'
const INDEX_PAGE_SIZE = 500

export type RetrievalConfig = {
  anchorLimit: number
  before: number
  after: number
  semantic: boolean
  keyword: boolean
}

export type ConversationRow = {
  id: string
  title: string | null
  project_id: string | null
  updated_at?: string | null
}

export type ConversationEdges = { opening: MessageRow[]; recent: MessageRow[] }

export async function fetchAllConversationMessages(supabase: SupabaseServer, userId: string, conversationId: string): Promise<{ rows: MessageRow[]; error: unknown | null }> {
  const rows: MessageRow[] = []
  let afterSeq = 0
  while (true) {
    const { data, error } = await supabase.from('messages').select(MESSAGE_FIELDS)
      .eq('conversation_id', conversationId).eq('user_id', userId)
      .gt('seq', afterSeq).order('seq', { ascending: true }).limit(INDEX_PAGE_SIZE)
    if (error) return { rows: [], error }
    const page = (data ?? []) as MessageRow[]
    if (!page.length) break
    const lastSeq = page[page.length - 1].seq
    if (!Number.isSafeInteger(lastSeq) || (lastSeq ?? 0) <= afterSeq) {
      return { rows: [], error: new Error('Conversation message sequence did not advance') }
    }
    rows.push(...page)
    afterSeq = lastSeq as number
    if (page.length < INDEX_PAGE_SIZE) break
  }
  return { rows, error: null }
}

export async function fetchConversationEdges(supabase: SupabaseServer, userId: string, conversationId: string): Promise<ConversationEdges> {
  const [openingResult, recentResult] = await Promise.all([
    supabase.from('messages').select(MESSAGE_FIELDS).eq('user_id', userId).eq('conversation_id', conversationId)
      .order('seq', { ascending: true }).limit(3),
    supabase.from('messages').select(MESSAGE_FIELDS).eq('user_id', userId).eq('conversation_id', conversationId)
      .order('seq', { ascending: false }).limit(4),
  ])
  return {
    opening: ((openingResult.error ? [] : openingResult.data ?? []) as MessageRow[]),
    recent: ((recentResult.error ? [] : recentResult.data ?? []) as MessageRow[]).reverse(),
  }
}

export async function fetchRowsAroundAnchor(supabase: SupabaseServer, userId: string, conversationId: string, anchor: MessageRow, config: RetrievalConfig): Promise<MessageRow[]> {
  if (!Number.isSafeInteger(anchor.seq) || (anchor.seq ?? 0) < 1) return [anchor]
  const seq = anchor.seq as number
  const { data, error } = await supabase.from('messages').select(MESSAGE_FIELDS)
    .eq('user_id', userId).eq('conversation_id', conversationId)
    .gte('seq', Math.max(1, seq - config.before)).lte('seq', seq + config.after)
    .order('seq', { ascending: true }).limit(config.before + config.after + 1)
  const rows = error ? [] : (data ?? []) as MessageRow[]
  return rows.some(message => message.id === anchor.id) ? rows : [anchor]
}

function renderAnchoredContext(anchor: MessageRow, rows: MessageRow[], edges: ConversationEdges, config: RetrievalConfig): string {
  const anchorIndex = rows.findIndex(m => m.id === anchor.id)
  const safeAnchorIndex = anchorIndex >= 0 ? anchorIndex : 0
  const start = Math.max(0, safeAnchorIndex - config.before)
  const end = Math.min(rows.length, safeAnchorIndex + config.after + 1)
  const windowRows = rows.slice(start, end)
  const windowIds = new Set(windowRows.map(message => message.id))
  const openingRows = edges.opening.filter(message => !windowIds.has(message.id))
  const recentRows = edges.recent.filter(message => !windowIds.has(message.id))

  return [
    ...(openingRows.length ? ['【对话开篇｜最早消息】', openingRows.map(normalizeMessage).join('\n\n'), ''] : []),
    '【用户锚点｜只以这条用户消息作为事实核心】',
    normalizeMessage(anchor),
    '',
    `【上下文窗口｜前 ${config.before} 条 + 后 ${config.after} 条】`,
    windowRows.map(normalizeMessage).join('\n\n'),
    ...(recentRows.length ? ['', '【最近对话｜最新消息】', recentRows.map(normalizeMessage).join('\n\n')] : []),
  ].join('\n').trim()
}

export function buildAnchoredHit(args: {
  anchor: MessageRow
  rows: MessageRow[]
  edges: ConversationEdges
  conversation: ConversationRow
  config: RetrievalConfig
  similarity: number
}): RetrievalHit | null {
  const { anchor, rows, edges, conversation, config, similarity } = args
  const anchorIndex = rows.findIndex(m => m.id === anchor.id)
  if (anchorIndex < 0 || anchor.role !== 'user' || !(anchor.content ?? '').trim()) return null

  return {
    id: `user-anchor-${anchor.id}`,
    conversation_id: conversation.id,
    conversation_title: conversation.title ?? null,
    project_id: conversation.project_id ?? null,
    message_start_id: rows[0]?.id ?? anchor.id,
    message_end_id: rows[rows.length - 1]?.id ?? anchor.id,
    content: renderAnchoredContext(anchor, rows, edges, config),
    similarity,
    created_at: anchor.created_at ?? null,
  }
}

export async function messagesForChunkHit(supabase: SupabaseServer, userId: string, hit: RetrievalHit): Promise<MessageRow[]> {
  if (!hit.message_start_id || !hit.message_end_id) return []
  const boundaryIds = Array.from(new Set([hit.message_start_id, hit.message_end_id]))
  const { data: boundaryRows, error: boundaryError } = await supabase.from('messages').select(MESSAGE_FIELDS)
    .eq('user_id', userId).eq('conversation_id', hit.conversation_id).in('id', boundaryIds).limit(2)
  if (boundaryError || !boundaryRows?.length) return []
  const boundaries = boundaryRows as MessageRow[]
  const start = boundaries.find(message => message.id === hit.message_start_id)
  const end = boundaries.find(message => message.id === hit.message_end_id)
  if (!start || !end || !Number.isSafeInteger(start.seq) || !Number.isSafeInteger(end.seq)) return []
  const lowerSeq = Math.min(start.seq as number, end.seq as number)
  const upperSeq = Math.max(start.seq as number, end.seq as number)
  const { data, error } = await supabase.from('messages').select(MESSAGE_FIELDS)
    .eq('user_id', userId).eq('conversation_id', hit.conversation_id)
    .gte('seq', lowerSeq).lte('seq', upperSeq).order('seq', { ascending: true }).limit(16)
  return error ? [] : (data ?? []) as MessageRow[]
}
