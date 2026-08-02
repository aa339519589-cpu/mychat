import { createHmac } from 'node:crypto'
import type { SupabaseClient } from '@/lib/supabase/types'
import { isJsonValue, type JsonObject } from './contracts'

export const LIVE_JOB_BROADCAST_EVENT = 'job.event'
const MAX_COALESCED_DELTA_CHARS = 256

type RealtimeChannel = ReturnType<SupabaseClient['channel']>

export type LiveJobEventInput = {
  kind: string
  payload: JsonObject
  offset?: number
}

export type LiveJobEvent = LiveJobEventInput & {
  revision: number
}

export type AppliedOffsetDelta = {
  next: string
  appended: string
  gap: boolean
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function liveJobChannelName(jobId: string, secret = process.env.AGENT_CREDENTIAL_KEY): string | null {
  const key = secret?.trim()
  if (!key) return null
  const digest = createHmac('sha256', key).update(jobId).digest('base64url')
  return `job-live:${digest}`
}

export function parseLiveJobEvent(value: unknown): LiveJobEvent | null {
  const source = record(value)
  const payload = source && isJsonValue(source.payload)
    && source.payload !== null && typeof source.payload === 'object' && !Array.isArray(source.payload)
    ? source.payload as JsonObject
    : null
  const revision = source && Number.isSafeInteger(source.revision) && Number(source.revision) > 0
    ? Number(source.revision)
    : null
  const offset = source?.offset === undefined
    ? undefined
    : Number.isSafeInteger(source.offset) && Number(source.offset) >= 0
      ? Number(source.offset)
      : null
  if (!source || revision === null || typeof source.kind !== 'string' || !payload || offset === null) return null
  return {
    revision,
    kind: source.kind,
    payload,
    ...(offset === undefined ? {} : { offset }),
  }
}

export function applyOffsetDelta(current: string, offset: number, value: string): AppliedOffsetDelta {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > current.length) {
    return { next: current, appended: '', gap: offset > current.length }
  }
  const overlap = current.length - offset
  if (overlap >= value.length) return { next: current, appended: '', gap: false }
  const appended = value.slice(Math.max(0, overlap))
  return { next: current + appended, appended, gap: false }
}

function deltaText(event: LiveJobEvent): { field: 'text' | 'thinking'; value: string } | null {
  if (event.kind === 'text.delta' && typeof event.payload.text === 'string') {
    return { field: 'text', value: event.payload.text }
  }
  if (event.kind === 'thinking.delta' && typeof event.payload.thinking === 'string') {
    return { field: 'thinking', value: event.payload.thinking }
  }
  return null
}

function canCoalesce(previous: LiveJobEvent, current: LiveJobEvent): boolean {
  const left = deltaText(previous)
  const right = deltaText(current)
  if (!left || !right || left.field !== right.field
    || previous.offset === undefined || current.offset === undefined) return false
  return previous.offset + left.value.length === current.offset
    && left.value.length + right.value.length <= MAX_COALESCED_DELTA_CHARS
}

function coalesced(previous: LiveJobEvent, current: LiveJobEvent): LiveJobEvent {
  const left = deltaText(previous)
  const right = deltaText(current)
  if (!left || !right) return current
  return {
    ...previous,
    revision: current.revision,
    payload: { [left.field]: `${left.value}${right.value}` },
  }
}

/**
 * Best-effort low-latency relay. Durable job events remain the recovery source;
 * this channel removes the database read loop from the visible token path.
 */
export class LiveJobPublisher {
  private readonly client: SupabaseClient
  private readonly channel: RealtimeChannel | null
  private queue: LiveJobEvent[] = []
  private revision = 0
  private ready = false
  private started = false
  private sending = false
  private closed = false

  constructor(client: SupabaseClient, jobId: string) {
    this.client = client
    const channelName = liveJobChannelName(jobId)
    this.channel = channelName
      ? client.channel(channelName, { config: { broadcast: { ack: false, self: false } } })
      : null
  }

  start(): void {
    if (!this.channel || this.started || this.closed) return
    this.started = true
    this.channel.subscribe(status => {
      this.ready = status === 'SUBSCRIBED'
      if (this.ready) void this.flush()
    })
  }

  publish(input: LiveJobEventInput): void {
    if (!this.channel || this.closed) return
    const event: LiveJobEvent = { ...input, revision: ++this.revision }
    const previous = this.queue.at(-1)
    if (previous && canCoalesce(previous, event)) this.queue[this.queue.length - 1] = coalesced(previous, event)
    else this.queue.push(event)
    void this.flush()
  }

  async close(): Promise<void> {
    if (this.closed) return
    if (this.ready) await this.flush()
    this.closed = true
    this.queue = []
    if (this.channel) {
      try { await this.client.removeChannel(this.channel) } catch {}
    }
  }

  private async flush(): Promise<void> {
    if (!this.channel || !this.ready || this.sending || this.closed) return
    this.sending = true
    try {
      while (this.ready && !this.closed && this.queue.length > 0) {
        const event = this.queue.shift()
        if (!event) break
        try {
          await this.channel.send({
            type: 'broadcast',
            event: LIVE_JOB_BROADCAST_EVENT,
            payload: event,
          })
        } catch {
          // Durable events provide loss recovery; live relay failures never fail the job.
        }
      }
    } finally {
      this.sending = false
      if (this.ready && !this.closed && this.queue.length > 0) void this.flush()
    }
  }
}
