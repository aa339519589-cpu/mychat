import type { SupabaseClient } from '@/lib/supabase/types'
import { isJsonValue, type JsonObject } from './contracts'
import {
  LIVE_JOB_BROADCAST_EVENT,
  applyOffsetDelta,
  liveJobChannelName,
  parseLiveJobEvent,
  type LiveJobEvent,
} from './live-events'
import {
  readOwnedJob,
  readOwnedJobEvents,
  type PublicJobEvent,
  type PublicJobSnapshot,
} from './read-model'

const DATABASE_RECOVERY_INTERVAL_MS = 500
const HEARTBEAT_INTERVAL_MS = 10_000
const ADMISSION_RENEW_INTERVAL_MS = 15_000
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

type LiveJobEventStreamOptions = {
  client: SupabaseClient
  principalId: string
  jobId: string
  fromSequence: number
  initialJob: PublicJobSnapshot
  requestSignal: AbortSignal
  maxDurationMs: number
  renewAdmission?: (signal?: AbortSignal) => Promise<boolean>
  onClosed?: () => void | Promise<void>
}

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
  return jsonObject(job.result) ?? job.progress
}

function authoritativeText(
  job: PublicJobSnapshot,
  stateValue: string,
  sourceValue: unknown,
): string {
  if (typeof sourceValue !== 'string') return stateValue
  if (terminal(job.status)) return sourceValue
  return sourceValue.length >= stateValue.length ? sourceValue : stateValue
}

function snapshotPayload(job: PublicJobSnapshot, state: LiveStreamState): JsonObject {
  const source = sourceSnapshot(job)
  return {
    content: authoritativeText(job, state.content, source.content),
    thinking: authoritativeText(job, state.thinking, source.thinking),
    ...(Array.isArray(source.media) ? { media: source.media } : {}),
  }
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

class LiveJobEventStreamSession {
  private readonly options: LiveJobEventStreamOptions
  private readonly lifetime = new AbortController()
  private readonly signal: AbortSignal
  private readonly state: LiveStreamState
  private readonly channel
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null
  private processing: Promise<void> = Promise.resolve()
  private closed = false
  private lastHeartbeatAt = Date.now()
  private lastAdmissionRenewAt = Date.now()

  constructor(options: LiveJobEventStreamOptions) {
    this.options = options
    this.signal = AbortSignal.any([options.requestSignal, this.lifetime.signal])
    this.state = {
      sequence: options.fromSequence,
      databaseSequence: 0,
      content: '',
      thinking: '',
      databaseContentLength: 0,
      databaseThinkingLength: 0,
    }
    const channelName = liveJobChannelName(options.jobId)
    this.channel = channelName
      ? options.client.channel(channelName, { config: { broadcast: { ack: false, self: false } } })
      : null
  }

  start(controller: ReadableStreamDefaultController<Uint8Array>): void {
    this.controller = controller
    if (this.channel) {
      this.channel.on('broadcast', { event: LIVE_JOB_BROADCAST_EVENT }, message => {
        const event = parseLiveJobEvent(record(message)?.payload)
        if (!event || this.closed) return
        this.processing = this.processing
          .then(() => this.applyLiveEvent(event))
          .catch(() => undefined)
      }).subscribe()
    }
    this.options.requestSignal.addEventListener('abort', () => { void this.close() }, { once: true })
    void this.run()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.lifetime.abort(new DOMException('Live stream closed', 'AbortError'))
    if (this.channel) {
      try { await this.options.client.removeChannel(this.channel) } catch {}
    }
    try { await this.options.onClosed?.() } catch {}
    try { this.controller?.close() } catch {}
  }

  private emit: StreamEmitter = (kind, payload) => {
    if (this.closed || !this.controller) return
    this.state.sequence += 1
    try {
      this.controller.enqueue(frame(this.options.jobId, this.state.sequence, kind, payload))
    } catch {
      void this.close()
    }
  }

  private resetState(): void {
    this.state.content = ''
    this.state.thinking = ''
    this.state.databaseContentLength = 0
    this.state.databaseThinkingLength = 0
  }

  private applyText(
    field: 'content' | 'thinking',
    offset: number,
    value: string,
  ): { appended: string; gap: boolean } {
    const applied = applyOffsetDelta(this.state[field], offset, value)
    this.state[field] = applied.next
    return { appended: applied.appended, gap: applied.gap }
  }

  private applyPersistedEvent(event: PublicJobEvent, emitMissing: boolean): void {
    if (resetEvent(event.kind, event.payload)) {
      this.resetState()
      if (emitMissing) this.emit(event.kind, event.payload)
      return
    }
    if (event.kind === 'text.delta' && typeof event.payload.text === 'string') {
      const offset = this.state.databaseContentLength
      this.state.databaseContentLength += event.payload.text.length
      const applied = this.applyText('content', offset, event.payload.text)
      if (emitMissing && applied.appended) this.emit('text.delta', { text: applied.appended })
      return
    }
    if (event.kind === 'thinking.delta' && typeof event.payload.thinking === 'string') {
      const offset = this.state.databaseThinkingLength
      this.state.databaseThinkingLength += event.payload.thinking.length
      const applied = this.applyText('thinking', offset, event.payload.thinking)
      if (emitMissing && applied.appended) this.emit('thinking.delta', { thinking: applied.appended })
      return
    }
    if (emitMissing && event.kind !== 'job.terminal') this.emit(event.kind, event.payload)
  }

  private async catchUpDatabase(emitMissing: boolean): Promise<void> {
    while (!this.signal.aborted) {
      const result = await readOwnedJobEvents(
        this.options.client,
        this.options.principalId,
        this.options.jobId,
        this.state.databaseSequence,
        EVENT_BATCH_SIZE,
        this.signal,
      )
      if (!result.ok) return
      for (const event of result.value) {
        this.state.databaseSequence = event.seq
        this.applyPersistedEvent(event, emitMissing)
      }
      if (result.value.length < EVENT_BATCH_SIZE) return
    }
  }

  private async applyLiveEvent(event: LiveJobEvent): Promise<void> {
    if (resetEvent(event.kind, event.payload)) {
      this.resetState()
      this.emit(event.kind, event.payload)
      return
    }
    const delta = event.kind === 'text.delta' && typeof event.payload.text === 'string'
      ? { field: 'content' as const, payloadField: 'text' as const, value: event.payload.text }
      : event.kind === 'thinking.delta' && typeof event.payload.thinking === 'string'
        ? { field: 'thinking' as const, payloadField: 'thinking' as const, value: event.payload.thinking }
        : null
    if (!delta || event.offset === undefined) {
      this.emit(event.kind, event.payload)
      return
    }
    let applied = this.applyText(delta.field, event.offset, delta.value)
    if (applied.gap) {
      await this.catchUpDatabase(true)
      applied = this.applyText(delta.field, event.offset, delta.value)
    }
    if (applied.appended) this.emit(event.kind, { [delta.payloadField]: applied.appended })
  }

  private emitSnapshot(job: PublicJobSnapshot): void {
    const payload = snapshotPayload(job, this.state)
    this.state.content = typeof payload.content === 'string' ? payload.content : this.state.content
    this.state.thinking = typeof payload.thinking === 'string' ? payload.thinking : this.state.thinking
    this.emit('job.snapshot', payload)
  }

  private async finishIfTerminal(job: PublicJobSnapshot): Promise<boolean> {
    if (!terminal(job.status)) return false
    await this.catchUpDatabase(true)
    this.emitSnapshot(job)
    this.emit('job.terminal', {
      status: job.status,
      result: job.result,
      errorCode: job.errorCode,
    })
    await this.close()
    return true
  }

  private async maintainAdmission(): Promise<boolean> {
    if (!this.options.renewAdmission
      || Date.now() - this.lastAdmissionRenewAt < ADMISSION_RENEW_INTERVAL_MS) return true
    this.lastAdmissionRenewAt = Date.now()
    return this.options.renewAdmission(this.signal)
  }

  private heartbeat(): void {
    if (!this.controller || Date.now() - this.lastHeartbeatAt < HEARTBEAT_INTERVAL_MS) return
    this.lastHeartbeatAt = Date.now()
    try { this.controller.enqueue(encoder.encode(': heartbeat\n\n')) } catch { void this.close() }
  }

  private async run(): Promise<void> {
    try {
      await this.catchUpDatabase(false)
      this.emitSnapshot(this.options.initialJob)
      if (await this.finishIfTerminal(this.options.initialJob)) return
      const deadline = Date.now() + this.options.maxDurationMs
      while (!this.signal.aborted && Date.now() < deadline) {
        await wait(DATABASE_RECOVERY_INTERVAL_MS, this.signal)
        await this.processing
        await this.catchUpDatabase(true)
        if (!(await this.maintainAdmission())) return
        const current = await readOwnedJob(
          this.options.client,
          this.options.principalId,
          this.options.jobId,
          this.signal,
        )
        if (current.ok && await this.finishIfTerminal(current.value)) return
        this.heartbeat()
      }
    } catch {
      // Closing without a terminal event makes the browser reconnect from a full snapshot.
    } finally {
      await this.close()
    }
  }
}

export function createLiveJobEventStream(options: LiveJobEventStreamOptions): ReadableStream<Uint8Array> {
  let session: LiveJobEventStreamSession | null = null
  return new ReadableStream<Uint8Array>({
    start(controller) {
      session = new LiveJobEventStreamSession(options)
      session.start(controller)
    },
    cancel() {
      void session?.close()
    },
  })
}
