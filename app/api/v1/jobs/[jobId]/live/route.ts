import { NextRequest } from 'next/server'
import { apiErrorResponseV1 } from '@/lib/api/errors'
import { resolveAuth } from '@/lib/api/guard'
import { clientAddress } from '@/lib/api/request'
import { isJsonValue, type JsonObject } from '@/lib/jobs/contracts'
import {
  LIVE_JOB_BROADCAST_EVENT,
  applyOffsetDelta,
  liveJobChannelName,
  parseLiveJobEvent,
  type LiveJobEvent,
} from '@/lib/jobs/live-events'
import {
  readOwnedJob,
  readOwnedJobEvents,
  type PublicJobEvent,
  type PublicJobSnapshot,
} from '@/lib/jobs/read-model'
import { acquireJobEventStreamLease } from '@/lib/jobs/stream-admission'
import { isUuid } from '@/lib/validation'

const SEQUENCE = /^(?:0|[1-9][0-9]{0,15})$/
const DATABASE_RECOVERY_INTERVAL_MS = 500
const HEARTBEAT_INTERVAL_MS = 10_000
const EVENT_BATCH_SIZE = 200
const encoder = new TextEncoder()

type LiveStreamState = {
  sequence: number
  databaseSequence: number
  content: string
  thinking: string
  databaseContentLength: number
  databaseThinkingLength: number
}

type StreamEmitter = (kind: string, payload: JsonObject) => void

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function jsonObject(value: unknown): JsonObject | null {
  return isJsonValue(value) && value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null
}

function terminal(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function resetEvent(kind: string, payload: JsonObject): boolean {
  return kind === 'job.retry_scheduled'
    || (kind === 'job.leased' && typeof payload.attempt === 'number' && payload.attempt > 1)
}

function frame(jobId: string, sequence: number, kind: string, payload: JsonObject): Uint8Array {
  return encoder.encode([
    `id: ${sequence}`,
    `event: ${kind}`,
    `data: ${JSON.stringify({ jobId, seq: sequence, kind, payload })}`,
    '',
    '',
  ].join('\n'))
}

function sourceSnapshot(job: PublicJobSnapshot): JsonObject {
  const result = jsonObject(job.result)
  return result ?? job.progress
}

function snapshotPayload(job: PublicJobSnapshot, state: LiveStreamState): JsonObject {
  const source = sourceSnapshot(job)
  const content = typeof source.content === 'string' ? source.content : state.content
  const thinking = typeof source.thinking === 'string' ? source.thinking : state.thinking
  return {
    content,
    thinking,
    ...(Array.isArray(source.media) ? { media: source.media } : {}),
  }
}

function resetState(state: LiveStreamState): void {
  state.content = ''
  state.thinking = ''
  state.databaseContentLength = 0
  state.databaseThinkingLength = 0
}

function applyText(
  state: LiveStreamState,
  field: 'content' | 'thinking',
  offset: number,
  value: string,
): { appended: string; gap: boolean } {
  const applied = applyOffsetDelta(state[field], offset, value)
  state[field] = applied.next
  return { appended: applied.appended, gap: applied.gap }
}

function applyPersistedEvent(
  state: LiveStreamState,
  event: PublicJobEvent,
  emitMissing: boolean,
  emit: StreamEmitter,
): void {
  if (resetEvent(event.kind, event.payload)) {
    resetState(state)
    if (emitMissing) emit(event.kind, event.payload)
    return
  }
  if (event.kind === 'text.delta' && typeof event.payload.text === 'string') {
    const offset = state.databaseContentLength
    state.databaseContentLength += event.payload.text.length
    const applied = applyText(state, 'content', offset, event.payload.text)
    if (emitMissing && applied.appended) emit('text.delta', { text: applied.appended })
    return
  }
  if (event.kind === 'thinking.delta' && typeof event.payload.thinking === 'string') {
    const offset = state.databaseThinkingLength
    state.databaseThinkingLength += event.payload.thinking.length
    const applied = applyText(state, 'thinking', offset, event.payload.thinking)
    if (emitMissing && applied.appended) emit('thinking.delta', { thinking: applied.appended })
    return
  }
  if (emitMissing && event.kind !== 'job.terminal') emit(event.kind, event.payload)
}

async function catchUpDatabase(input: {
  client: NonNullable<Awaited<ReturnType<typeof resolveAuth>>['supabase']>
  principalId: string
  jobId: string
  signal: AbortSignal
  state: LiveStreamState
  emitMissing: boolean
  emit: StreamEmitter
}): Promise<void> {
  while (!input.signal.aborted) {
    const result = await readOwnedJobEvents(
      input.client,
      input.principalId,
      input.jobId,
      input.state.databaseSequence,
      EVENT_BATCH_SIZE,
      input.signal,
    )
    if (!result.ok) return
    for (const event of result.value) {
      input.state.databaseSequence = event.seq
      applyPersistedEvent(input.state, event, input.emitMissing, input.emit)
    }
    if (result.value.length < EVENT_BATCH_SIZE) return
  }
}

async function applyLiveEvent(input: {
  event: LiveJobEvent
  client: NonNullable<Awaited<ReturnType<typeof resolveAuth>>['supabase']>
  principalId: string
  jobId: string
  signal: AbortSignal
  state: LiveStreamState
  emit: StreamEmitter
}): Promise<void> {
  const { event, state } = input
  if (resetEvent(event.kind, event.payload)) {
    resetState(state)
    input.emit(event.kind, event.payload)
    return
  }
  const delta = event.kind === 'text.delta' && typeof event.payload.text === 'string'
    ? { field: 'content' as const, payloadField: 'text' as const, value: event.payload.text }
    : event.kind === 'thinking.delta' && typeof event.payload.thinking === 'string'
      ? { field: 'thinking' as const, payloadField: 'thinking' as const, value: event.payload.thinking }
      : null
  if (!delta || event.offset === undefined) {
    input.emit(event.kind, event.payload)
    return
  }
  let applied = applyText(state, delta.field, event.offset, delta.value)
  if (applied.gap) {
    await catchUpDatabase({ ...input, emitMissing: true })
    applied = applyText(state, delta.field, event.offset, delta.value)
  }
  if (applied.appended) input.emit(event.kind, { [delta.payloadField]: applied.appended })
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const timer = setTimeout(resolve, milliseconds)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason)
    }, { once: true })
  })
}

export async function GET(request: NextRequest, context: { params: Promise<{ jobId: string }> }) {
  const auth = await resolveAuth(request)
  if (auth.authUnavailable) return apiErrorResponseV1(request, {
    status: 503, code: 'AUTH_DEPENDENCY_UNAVAILABLE', message: '认证服务暂时不可用', retryable: true,
    headers: { 'Retry-After': '5' },
  })
  if (!auth.supabase || !auth.userId) return apiErrorResponseV1(request, {
    status: 401, code: 'AUTH_REQUIRED', message: '请先登录', retryable: false,
  })
  const { jobId } = await context.params
  const requestedSequence = new URL(request.url).searchParams.get('from_seq')
    ?? request.headers.get('last-event-id') ?? '0'
  if (!isUuid(jobId) || !SEQUENCE.test(requestedSequence)) return apiErrorResponseV1(request, {
    status: 400, code: 'INVALID_REQUEST', message: '作业订阅参数无效', retryable: false,
  })
  const fromSequence = Number(requestedSequence)
  if (!Number.isSafeInteger(fromSequence)) return apiErrorResponseV1(request, {
    status: 400, code: 'INVALID_REQUEST', message: 'from_seq 无效', retryable: false,
  })
  const initial = await readOwnedJob(auth.supabase, auth.userId, jobId, request.signal)
  if (!initial.ok) return apiErrorResponseV1(request, initial.kind === 'not_found' ? {
    status: 404, code: 'NOT_FOUND', message: '作业不存在', retryable: false,
  } : {
    status: 503, code: 'DEPENDENCY_UNAVAILABLE', message: '作业事件暂时不可用', retryable: true,
    headers: { 'Retry-After': '1' },
  })
  const admission = await acquireJobEventStreamLease({
    principalId: auth.userId,
    jobId,
    address: clientAddress(request),
    signal: request.signal,
  })
  if (!admission.acquired) return apiErrorResponseV1(request, {
    status: admission.kind === 'capacity' ? 429 : 503,
    code: admission.kind === 'capacity' ? 'RATE_LIMITED' : 'DEPENDENCY_UNAVAILABLE',
    message: admission.kind === 'capacity' ? '作业事件连接数已达上限' : '作业事件服务暂时不可用',
    retryable: true,
    headers: { 'Retry-After': String(admission.retryAfterSeconds) },
  })

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const lifetime = new AbortController()
      const signal = AbortSignal.any([request.signal, lifetime.signal])
      const state: LiveStreamState = {
        sequence: fromSequence,
        databaseSequence: 0,
        content: '',
        thinking: '',
        databaseContentLength: 0,
        databaseThinkingLength: 0,
      }
      let closed = false
      let processing = Promise.resolve()
      let lastHeartbeatAt = Date.now()
      const channelName = liveJobChannelName(jobId)
      const channel = channelName
        ? auth.supabase.channel(channelName, { config: { broadcast: { ack: false, self: false } } })
        : null

      const close = async () => {
        if (closed) return
        closed = true
        lifetime.abort(new DOMException('Live stream closed', 'AbortError'))
        if (channel) {
          try { await auth.supabase.removeChannel(channel) } catch {}
        }
        await admission.lease.release().catch(() => undefined)
        try { controller.close() } catch {}
      }
      const emit: StreamEmitter = (kind, payload) => {
        if (closed) return
        state.sequence += 1
        try { controller.enqueue(frame(jobId, state.sequence, kind, payload)) } catch { void close() }
      }
      const emitSnapshot = (job: PublicJobSnapshot) => {
        const payload = snapshotPayload(job, state)
        state.content = typeof payload.content === 'string' ? payload.content : state.content
        state.thinking = typeof payload.thinking === 'string' ? payload.thinking : state.thinking
        emit('job.snapshot', payload)
      }
      const finishIfTerminal = async (job: PublicJobSnapshot): Promise<boolean> => {
        if (!terminal(job.status)) return false
        await catchUpDatabase({
          client: auth.supabase,
          principalId: auth.userId,
          jobId,
          signal,
          state,
          emitMissing: true,
          emit,
        })
        emitSnapshot(job)
        emit('job.terminal', {
          status: job.status,
          result: job.result,
          errorCode: job.errorCode,
        })
        await close()
        return true
      }

      if (channel) {
        channel.on('broadcast', { event: LIVE_JOB_BROADCAST_EVENT }, message => {
          const event = parseLiveJobEvent(record(message)?.payload)
          if (!event || closed) return
          processing = processing.then(() => applyLiveEvent({
            event,
            client: auth.supabase,
            principalId: auth.userId,
            jobId,
            signal,
            state,
            emit,
          })).catch(() => undefined)
        }).subscribe()
      }

      request.signal.addEventListener('abort', () => { void close() }, { once: true })
      void (async () => {
        try {
          await catchUpDatabase({
            client: auth.supabase,
            principalId: auth.userId,
            jobId,
            signal,
            state,
            emitMissing: false,
            emit,
          })
          emitSnapshot(initial.value)
          if (await finishIfTerminal(initial.value)) return
          const deadline = Date.now() + admission.lease.maxDurationMs
          while (!signal.aborted && Date.now() < deadline) {
            await wait(DATABASE_RECOVERY_INTERVAL_MS, signal)
            await processing
            await catchUpDatabase({
              client: auth.supabase,
              principalId: auth.userId,
              jobId,
              signal,
              state,
              emitMissing: true,
              emit,
            })
            const current = await readOwnedJob(auth.supabase, auth.userId, jobId, signal)
            if (current.ok && await finishIfTerminal(current.value)) return
            if (Date.now() - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
              lastHeartbeatAt = Date.now()
              try { controller.enqueue(encoder.encode(': heartbeat\n\n')) } catch { await close(); return }
            }
          }
        } catch {
          // Closing without a terminal event makes the browser reconnect from a full snapshot.
        } finally {
          await close()
        }
      })()
    },
    cancel() {
      void admission.lease.release().catch(() => undefined)
    },
  })

  return new Response(stream, { headers: {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  } })
}
