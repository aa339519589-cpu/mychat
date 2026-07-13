import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/admin'
import { failStaleGeneration, isGenerationLeaseExpired } from './lease'
import {
  normalizeGenerationMedia,
  type GenerationDatabaseRow,
  type GenerationStatus,
} from './types'

const GENERATION_QUERY_TIMEOUT_MS = 8_000

type QueryResult<T> = { data: T | null; error: unknown }

export type GenerationReadOptions = {
  timeoutMs?: number
  createAdminClient?: () => SupabaseClient | null
}

export type GenerationReadUnavailableReason =
  | 'query_timeout'
  | 'database_error'
  | 'invalid_response'
  | 'stale_settlement_failed'

export type GenerationReadResult<T> =
  | { kind: 'found'; value: T }
  | { kind: 'not_found' }
  | {
      kind: 'unavailable'
      reason: GenerationReadUnavailableReason
      errorCode?: string
    }

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const value = error as { code?: unknown; errorCode?: unknown }
  if (typeof value.code === 'string') return value.code
  return typeof value.errorCode === 'string' ? value.errorCode : undefined
}

function unavailable<T>(
  reason: GenerationReadUnavailableReason,
  error?: unknown,
): GenerationReadResult<T> {
  const code = errorCode(error)
  return {
    kind: 'unavailable',
    reason,
    ...(code ? { errorCode: code } : {}),
  }
}

function isGenerationStatus(value: unknown): value is GenerationStatus {
  return value === 'queued' || value === 'running' || value === 'completed'
    || value === 'failed' || value === 'cancelled'
}

async function executeGenerationQuery<T>(
  query: PromiseLike<QueryResult<T>> & {
    abortSignal?: (signal: AbortSignal) => PromiseLike<QueryResult<T>>
  },
  timeoutMs = GENERATION_QUERY_TIMEOUT_MS,
): Promise<QueryResult<T>> {
  const controller = new AbortController()
  const operation = typeof query.abortSignal === 'function'
    ? query.abortSignal(controller.signal)
    : query
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve(operation),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort()
          reject(new DOMException('Generation query timed out', 'TimeoutError'))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function settleExpiredRow(
  supabase: SupabaseClient,
  row: GenerationDatabaseRow,
  userId: string,
): Promise<GenerationReadResult<GenerationDatabaseRow>> {
  if (!isGenerationLeaseExpired(row)) return { kind: 'found', value: row }
  const result = await failStaleGeneration(
    { userId, generationId: row.id },
    { createAdminClient: () => supabase },
  )
  if (!result.ok) {
    return unavailable('stale_settlement_failed', result)
  }
  if (!result.status) return { kind: 'not_found' }
  if (!isGenerationStatus(result.status)) return unavailable('invalid_response')
  return {
    kind: 'found',
    value: {
      ...row,
      status: result.status,
      content: result.content ?? row.content,
      thinking: result.thinking ?? row.thinking,
      sequence: result.sequence ?? row.sequence,
      error: result.error ?? row.error,
      media: result.media,
      ...(result.status === 'failed' || result.status === 'completed' || result.status === 'cancelled'
        ? { lease_owner: null, lease_expires_at: null }
        : {}),
    },
  }
}

function privilegedClient(options: GenerationReadOptions): SupabaseClient | null {
  try {
    return (options.createAdminClient ?? createAdminClient)()
  } catch {
    return null
  }
}

export async function loadGenerationFromDb(
  id: string,
  userId: string,
  options: GenerationReadOptions = {},
): Promise<GenerationReadResult<GenerationDatabaseRow>> {
  const supabase = privilegedClient(options)
  if (!supabase) return unavailable('database_error', { code: 'admin_not_configured' })
  try {
    const query = supabase.from('chat_generations')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .maybeSingle()
    const { data, error } = await executeGenerationQuery<GenerationDatabaseRow>(
      query,
      options.timeoutMs ?? GENERATION_QUERY_TIMEOUT_MS,
    )
    if (error) return unavailable('database_error', error)
    if (!data) return { kind: 'not_found' }
    const media = normalizeGenerationMedia(data.media)
    if (!media) return unavailable('invalid_response')
    return settleExpiredRow(supabase, { ...data, media }, userId)
  } catch (error) {
    return unavailable(
      error instanceof Error && error.name === 'TimeoutError' ? 'query_timeout' : 'database_error',
      error,
    )
  }
}

/** Lightweight status read used by a runner to observe cancellation from another instance. */
export async function loadGenerationStatusFromDb(
  id: string,
  userId: string,
  options: GenerationReadOptions = {},
): Promise<GenerationReadResult<GenerationStatus>> {
  const supabase = privilegedClient(options)
  if (!supabase) return unavailable('database_error', { code: 'admin_not_configured' })
  try {
    const query = supabase.from('chat_generations')
      .select('status,lease_expires_at')
      .eq('id', id)
      .eq('user_id', userId)
      .maybeSingle()
    const { data, error } = await executeGenerationQuery<{
      status: unknown
      lease_expires_at?: string | null
    }>(query, options.timeoutMs ?? GENERATION_QUERY_TIMEOUT_MS)
    if (error) return unavailable('database_error', error)
    if (!data) return { kind: 'not_found' }
    let status = data.status
    if ((status === 'queued' || status === 'running')
      && isGenerationLeaseExpired({ status, lease_expires_at: data.lease_expires_at })) {
      const settled = await failStaleGeneration(
        { userId, generationId: id },
        { createAdminClient: () => supabase },
      )
      if (!settled.ok) return unavailable('stale_settlement_failed', settled)
      if (!settled.status) return { kind: 'not_found' }
      status = settled.status
    }
    if (isGenerationStatus(status)) return { kind: 'found', value: status }
    return unavailable('invalid_response')
  } catch (error) {
    return unavailable(
      error instanceof Error && error.name === 'TimeoutError' ? 'query_timeout' : 'database_error',
      error,
    )
  }
}

export async function loadRunningGenerations(
  userId: string,
  conversationId: string,
  options: GenerationReadOptions = {},
): Promise<GenerationReadResult<GenerationDatabaseRow[]>> {
  const supabase = privilegedClient(options)
  if (!supabase) return unavailable('database_error', { code: 'admin_not_configured' })
  try {
    const query = supabase.from('chat_generations')
      .select('*')
      .eq('user_id', userId)
      .eq('conversation_id', conversationId)
      .in('status', ['queued', 'running'])
      .order('created_at', { ascending: false })
      .limit(5)
    const { data, error } = await executeGenerationQuery<GenerationDatabaseRow[]>(
      query,
      options.timeoutMs ?? GENERATION_QUERY_TIMEOUT_MS,
    )
    if (error) return unavailable('database_error', error)
    if (!data) return { kind: 'not_found' }
    if (!Array.isArray(data)) return unavailable('invalid_response')
    const normalizedRows: GenerationDatabaseRow[] = []
    for (const row of data) {
      const media = normalizeGenerationMedia(row.media)
      if (!media) return unavailable('invalid_response')
      normalizedRows.push({ ...row, media })
    }
    const settled = await Promise.all(
      normalizedRows.map(row => settleExpiredRow(supabase, row, userId)),
    )
    const failed = settled.find(result => result.kind === 'unavailable')
    if (failed?.kind === 'unavailable') return failed
    const rows = settled.flatMap(result => result.kind === 'found' ? [result.value] : [])
    return {
      kind: 'found',
      value: rows.filter(row => row.status === 'queued' || row.status === 'running'),
    }
  } catch (error) {
    return unavailable(
      error instanceof Error && error.name === 'TimeoutError' ? 'query_timeout' : 'database_error',
      error,
    )
  }
}

/** Latest durable snapshot for cold-start reconciliation, including terminals. */
export async function loadLatestGenerationForConversation(
  userId: string,
  conversationId: string,
  options: GenerationReadOptions = {},
): Promise<GenerationReadResult<GenerationDatabaseRow>> {
  const supabase = privilegedClient(options)
  if (!supabase) return unavailable('database_error', { code: 'admin_not_configured' })
  try {
    const query = supabase.from('chat_generations')
      .select('*')
      .eq('user_id', userId)
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const { data, error } = await executeGenerationQuery<GenerationDatabaseRow>(
      query,
      options.timeoutMs ?? GENERATION_QUERY_TIMEOUT_MS,
    )
    if (error) return unavailable('database_error', error)
    if (!data) return { kind: 'not_found' }
    const media = normalizeGenerationMedia(data.media)
    if (!media) return unavailable('invalid_response')
    return settleExpiredRow(supabase, { ...data, media }, userId)
  } catch (error) {
    return unavailable(
      error instanceof Error && error.name === 'TimeoutError' ? 'query_timeout' : 'database_error',
      error,
    )
  }
}
