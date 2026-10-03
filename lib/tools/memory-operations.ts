import { classifyMemorySensitivity } from '@/lib/api/memory-sensitivity'
import { normalizeMemoryTopic } from '@/lib/api/memory-input'
import { log } from '@/lib/logger'
import { isRecord } from '@/lib/unknown-value'
import type { SupabaseClient } from '@/lib/supabase/types'
import type { ToolContext } from './types'

export type MemoryOperationResult = {
  action: 'create' | 'update' | 'delete' | 'duplicate'
  id?: string
  content?: string
  topic?: string
  ok: boolean
  timestamp?: string
  sensitive?: boolean
  reason?: 'sensitive_consent_required' | 'prohibited_content'
}

type MemoryTable = 'memories' | 'project_memories'
type SimilarMemory = { id: string; content: string; topic: string; sensitive: boolean; score: number }
const DEDUP_THRESHOLD = 0.55
const MAX_MEMORY_CHARS = 5_000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function charBigramJaccard(a: string, b: string): number {
  if (!a || !b) return 0
  const left = new Set(Array.from({ length: a.length - 1 }, (_, index) => a.slice(index, index + 2)))
  const right = new Set(Array.from({ length: b.length - 1 }, (_, index) => b.slice(index, index + 2)))
  if (!left.size && !right.size) return 0
  const intersection = [...left].filter(value => right.has(value)).length
  return intersection / new Set([...left, ...right]).size
}

async function comparableMemoryRows(
  supabase: SupabaseClient,
  table: MemoryTable,
  userId: string,
  projectId: string | null | undefined,
  sensitiveMemoryEnabled: boolean,
): Promise<unknown[]> {
  const query = table === 'project_memories'
    ? projectId
      ? supabase.from('project_memories').select('id,content,topic,sensitive')
        .eq('user_id', userId).eq('project_id', projectId)
      : null
    : supabase.from('memories').select('id,content,topic,sensitive').eq('user_id', userId)
  if (!query) return []
  const scoped = sensitiveMemoryEnabled ? query : query.eq('sensitive', false)
  const { data, error } = await scoped
  return error || !Array.isArray(data) ? [] : data
}

function bestSimilarMemory(content: string, rows: unknown[]): Omit<SimilarMemory, 'score'> | null {
  let best: SimilarMemory | null = null
  for (const value of rows) {
    if (!isRecord(value) || typeof value.id !== 'string' || typeof value.content !== 'string') continue
    const score = charBigramJaccard(content, value.content)
    if (score <= DEDUP_THRESHOLD || (best && score <= best.score)) continue
    best = {
      id: value.id,
      content: value.content,
      topic: typeof value.topic === 'string' && value.topic.trim() ? value.topic : 'General',
      sensitive: value.sensitive === true,
      score,
    }
  }
  return best
}

async function findSimilarMemory(
  ctx: ToolContext,
  table: MemoryTable,
  content: string,
): Promise<Omit<SimilarMemory, 'score'> | null> {
  if (!ctx.supabase || !ctx.userId) return null
  try {
    const rows = await comparableMemoryRows(
      ctx.supabase, table, ctx.userId, ctx.projectId, ctx.sensitiveMemoryEnabled === true,
    )
    return bestSimilarMemory(content, rows)
  } catch {
    return null
  }
}

function operationFailure(action: MemoryOperationResult['action'], id?: string): MemoryOperationResult {
  return { action, ...(id ? { id } : {}), ok: false }
}

function memoryContent(input: Record<string, unknown>, requiredTopic: boolean): {
  content: string
  topic?: string
} | null {
  const content = String(input.content ?? '').trim()
  const topic = input.topic === undefined ? undefined : normalizeMemoryTopic(input.topic)
  if (!content || content.length > MAX_MEMORY_CHARS || (input.topic !== undefined && !topic)) return null
  const selectedTopic = topic ?? (requiredTopic ? 'General' : undefined)
  return { content, ...(selectedTopic ? { topic: selectedTopic } : {}) }
}

function consentRefusal(
  classification: ReturnType<typeof classifyMemorySensitivity>,
  ctx: ToolContext,
  action: 'create' | 'update',
  id?: string,
): MemoryOperationResult | null {
  if (classification.prohibited) {
    return { ...operationFailure(action, id), reason: 'prohibited_content' }
  }
  if (classification.sensitive && ctx.sensitiveMemoryEnabled !== true) {
    return { ...operationFailure(action, id), reason: 'sensitive_consent_required' }
  }
  return null
}

async function createMemory(
  ctx: ToolContext,
  table: MemoryTable,
  input: Record<string, unknown>,
): Promise<MemoryOperationResult> {
  const candidate = memoryContent(input, true)
  if (!candidate) return operationFailure('create')
  const { content, topic = 'General' } = candidate
  if (table === 'project_memories' && !ctx.projectId) return operationFailure('create')
  const classification = classifyMemorySensitivity(content)
  const refusal = consentRefusal(classification, ctx, 'create')
  if (refusal) return refusal
  const supabase = ctx.supabase
  const userId = ctx.userId
  if (!supabase || !userId) return operationFailure('create')
  const timestamp = new Date().toISOString()
  const similar = await findSimilarMemory(ctx, table, content)
  if (similar) {
    log.info('memory', '发现相似记忆，交由模型判断合并或跳过', {
      table, projectId: ctx.projectId ?? null, similarId: similar.id,
      newContentLength: content.length, oldContentLength: similar.content.length,
    })
    return { action: 'duplicate', ...similar, ok: true, timestamp }
  }
  const id = crypto.randomUUID()
  const row = { id, user_id: userId, content, topic, sensitive: classification.sensitive }
  const result = table === 'project_memories'
    ? await supabase.from('project_memories').insert({ ...row, project_id: ctx.projectId as string })
    : await supabase.from('memories').insert(row)
  if (result.error) log.error('memory', '记忆写入失败', { table, code: result.error.code })
  else log.info('memory', '记忆已写入', { table, projectId: ctx.projectId ?? null })
  return {
    action: 'create', id, content, topic, sensitive: classification.sensitive,
    ok: !result.error, timestamp,
  }
}

async function updateMemory(
  ctx: ToolContext,
  table: MemoryTable,
  input: Record<string, unknown>,
): Promise<MemoryOperationResult> {
  const id = String(input.id ?? '')
  const candidate = memoryContent(input, false)
  if (!UUID_RE.test(id) || !candidate) {
    return { ...operationFailure('update', id), ...(candidate ? { content: candidate.content } : {}) }
  }
  const { content, topic } = candidate
  const refusal = consentRefusal(classifyMemorySensitivity(content), ctx, 'update', id)
  if (refusal) return { ...refusal, content }
  if (!ctx.supabase || !ctx.userId || (table === 'project_memories' && !ctx.projectId)) {
    return { ...operationFailure('update', id), content }
  }
  const timestamp = new Date().toISOString()
  const sensitive = classifyMemorySensitivity(content).sensitive
  const values = { content, updated_at: timestamp, ...(topic ? { topic } : {}), sensitive }
  const result = table === 'project_memories'
    ? await ctx.supabase.from('project_memories').update(values).eq('id', id)
      .eq('user_id', ctx.userId).eq('project_id', ctx.projectId as string).select('id').maybeSingle()
    : await ctx.supabase.from('memories').update(values).eq('id', id)
      .eq('user_id', ctx.userId).select('id').maybeSingle()
  if (result.error) log.error('memory', '记忆更新失败', { table, code: result.error.code })
  return {
    action: 'update', id, content, ...(topic ? { topic } : {}), sensitive,
    ok: !result.error && Boolean(result.data), timestamp,
  }
}

async function deleteMemory(
  ctx: ToolContext,
  table: MemoryTable,
  input: Record<string, unknown>,
): Promise<MemoryOperationResult> {
  const id = String(input.id ?? '')
  if (!UUID_RE.test(id)) return operationFailure('delete', id)
  if (!ctx.supabase || !ctx.userId || (table === 'project_memories' && !ctx.projectId)) {
    return operationFailure('delete', id)
  }
  const result = table === 'project_memories'
    ? await ctx.supabase.from('project_memories').delete().eq('id', id)
      .eq('user_id', ctx.userId).eq('project_id', ctx.projectId as string).select('id').maybeSingle()
    : await ctx.supabase.from('memories').delete().eq('id', id)
      .eq('user_id', ctx.userId).select('id').maybeSingle()
  if (result.error) log.error('memory', '记忆删除失败', { table, code: result.error.code })
  return { action: 'delete', id, ok: !result.error && Boolean(result.data) }
}

export async function runMemoryOperation(
  ctx: ToolContext,
  opName: string,
  table: MemoryTable,
  value: unknown,
): Promise<MemoryOperationResult> {
  if (!ctx.supabase || !ctx.userId) return operationFailure('create')
  const input = isRecord(value) ? value : {}
  const topic = input.topic === undefined ? undefined : normalizeMemoryTopic(input.topic)
  if (input.topic !== undefined && !topic) return operationFailure('create')
  try {
    if (opName === 'remember' || opName === 'remember_project') return createMemory(ctx, table, input)
    if (opName === 'update_memory' || opName === 'update_project_memory') return updateMemory(ctx, table, input)
    if (opName === 'forget' || opName === 'forget_project') return deleteMemory(ctx, table, input)
  } catch (error) {
    log.error('memory', `${opName} 异常`, error)
  }
  return operationFailure('create')
}
