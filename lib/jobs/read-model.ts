import type { SupabaseClient } from '@/lib/supabase/types'
import { isJobStatus, isJsonValue, type JobStatus, type JsonObject, type JsonValue } from './contracts'

const READ_TIMEOUT_MS = 8_000

export type PublicJobSnapshot = {
  id: string
  type: string
  queue: string
  subject: JsonObject
  status: JobStatus
  attempt: number
  maxAttempts: number
  priority: number
  availableAt: string
  cancelRequestedAt: string | null
  progress: JsonObject
  result: JsonValue | null
  errorClass: string | null
  errorCode: string | null
  eventSequence: number
  createdAt: string
  updatedAt: string
  startedAt: string | null
  terminalAt: string | null
}

export type PublicJobEvent = {
  id: string
  jobId: string
  seq: number
  kind: string
  schemaVersion: number
  payload: JsonObject
  createdAt: string
}

type ReadResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: 'not_found' | 'unavailable' | 'malformed' }

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function jsonObject(value: unknown): JsonObject | null {
  return isJsonValue(value) && value !== null && !Array.isArray(value) && typeof value === 'object'
    ? value
    : null
}

function integer(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null
}

function nullableString(value: unknown): string | null | undefined {
  return value === null ? null : typeof value === 'string' ? value : undefined
}

function boundedReadSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(READ_TIMEOUT_MS)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

function publicJob(value: unknown): PublicJobSnapshot | null {
  const row = object(value)
  if (!row) return null
  const attempt = integer(row.attempt)
  const maxAttempts = integer(row.max_attempts)
  const priority = Number.isSafeInteger(row.priority) ? Number(row.priority) : null
  const eventSequence = integer(row.event_sequence)
  const subject = jsonObject(row.subject)
  const progress = jsonObject(row.progress)
  const result = row.result === null ? null : isJsonValue(row.result) ? row.result : undefined
  const cancelRequestedAt = nullableString(row.cancel_requested_at)
  const errorClass = nullableString(row.error_class)
  const errorCode = nullableString(row.error_code)
  const startedAt = nullableString(row.started_at)
  const terminalAt = nullableString(row.terminal_at)
  if (typeof row.id !== 'string' || typeof row.type !== 'string' || typeof row.queue !== 'string'
    || !isJobStatus(row.status) || attempt === null || maxAttempts === null || priority === null
    || eventSequence === null || !subject || !progress || result === undefined
    || cancelRequestedAt === undefined || errorClass === undefined || errorCode === undefined
    || startedAt === undefined || terminalAt === undefined
    || typeof row.available_at !== 'string' || typeof row.created_at !== 'string'
    || typeof row.updated_at !== 'string') return null
  return {
    id: row.id,
    type: row.type,
    queue: row.queue,
    subject,
    status: row.status,
    attempt,
    maxAttempts,
    priority,
    availableAt: row.available_at,
    cancelRequestedAt,
    progress,
    result,
    errorClass,
    errorCode,
    eventSequence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt,
    terminalAt,
  }
}

export async function readOwnedJob(
  client: SupabaseClient,
  principalId: string,
  jobId: string,
  signal?: AbortSignal,
): Promise<ReadResult<PublicJobSnapshot>> {
  const { data, error } = await client.from('jobs').select([
    'id', 'type', 'queue', 'subject', 'status', 'attempt', 'max_attempts', 'priority',
    'available_at', 'cancel_requested_at', 'progress', 'result', 'error_class',
    'error_code', 'event_sequence', 'created_at', 'updated_at', 'started_at', 'terminal_at',
  ].join(','))
    .abortSignal(boundedReadSignal(signal))
    .eq('id', jobId).eq('principal_id', principalId).maybeSingle()
  if (error) return { ok: false, kind: 'unavailable' }
  if (!data) return { ok: false, kind: 'not_found' }
  const parsed = publicJob(data)
  return parsed ? { ok: true, value: parsed } : { ok: false, kind: 'malformed' }
}

export async function readLatestOwnedConversationJob(
  client: SupabaseClient,
  principalId: string,
  conversationId: string,
  signal?: AbortSignal,
): Promise<ReadResult<PublicJobSnapshot | null>> {
  const { data, error } = await client.from('jobs').select([
    'id', 'type', 'queue', 'subject', 'status', 'attempt', 'max_attempts', 'priority',
    'available_at', 'cancel_requested_at', 'progress', 'result', 'error_class',
    'error_code', 'event_sequence', 'created_at', 'updated_at', 'started_at', 'terminal_at',
  ].join(','))
    .eq('principal_id', principalId)
    .eq('type', 'chat.generation')
    .contains('subject', { conversationId })
    .order('created_at', { ascending: false })
    .limit(1)
    .abortSignal(boundedReadSignal(signal))
    .maybeSingle()
  if (error) return { ok: false, kind: 'unavailable' }
  if (!data) return { ok: true, value: null }
  const parsed = publicJob(data)
  return parsed ? { ok: true, value: parsed } : { ok: false, kind: 'malformed' }
}

export async function readOwnedJobEvents(
  client: SupabaseClient,
  principalId: string,
  jobId: string,
  afterSequence: number,
  limit = 200,
  signal?: AbortSignal,
): Promise<ReadResult<PublicJobEvent[]>> {
  const { data, error } = await client.from('job_events')
    .select('id,job_id,seq,kind,schema_version,payload,created_at')
    .eq('job_id', jobId).eq('principal_id', principalId)
    .gt('seq', afterSequence).order('seq', { ascending: true }).limit(limit)
    .abortSignal(boundedReadSignal(signal))
  if (error) return { ok: false, kind: 'unavailable' }
  const events: PublicJobEvent[] = []
  for (const value of data ?? []) {
    const row = object(value)
    const seq = integer(row?.seq)
    const schemaVersion = integer(row?.schema_version)
    const payload = jsonObject(row?.payload)
    if (!row || typeof row.id !== 'string' || row.job_id !== jobId || seq === null || seq < 1
      || typeof row.kind !== 'string' || schemaVersion === null || schemaVersion < 1
      || !payload || typeof row.created_at !== 'string') return { ok: false, kind: 'malformed' }
    events.push({
      id: row.id,
      jobId,
      seq,
      kind: row.kind,
      schemaVersion,
      payload,
      createdAt: row.created_at,
    })
  }
  return { ok: true, value: events }
}
