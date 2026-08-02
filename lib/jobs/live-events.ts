import { createHmac } from 'node:crypto'
import type { SupabaseClient } from '@/lib/supabase/types'
import { isJsonValue, type JsonObject } from './contracts'

export const LIVE_JOB_BROADCAST_EVENT = 'job.event'
const MAX_IN_FLIGHT_BROADCASTS = 8

type RealtimeChannel = ReturnType<SupabaseClient['channel']>
type ParsedOffset = { valid: boolean; value?: number }

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

function jsonObject(value: unknown): JsonObject | null {
  if (!isJsonValue(value) || value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as JsonObject
}

function positiveInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null
}

function parsedOffset(value: unknown): ParsedOffset {
  if (value === undefined) return { valid: true }
  if (!Number.isSafeInteger(value) || Number(value) < 0) return { valid: false }
  return { valid: true, value: Number(value) }
}

export function liveJobChannelName(jobId: string, secret = process.env.AGENT_CREDENTIAL_KEY): string | null {
  const key = secret?.trim()
  if (!key) return null
  const digest = createHmac('sha256', key).update(jobId).digest('base64url')
  return `job-live:${digest}`
}

export function parseLiveJobEvent(value: unknown): LiveJobEvent | null {
  const source = record(value)
  if (!source || typeof source.kind !== 'string') return null
  const payload = jsonObject(source.payload)
  const revision = positiveInteger(source.revision)
  const offset = parsedOffset(source.offset)
  if (!payload || revision === null || !offset.valid) return null
  return {
    revision,
    kind: source.kind,
    payload,
    ...(offset.value === undefined ? {} : { offset: offset.value }),
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

/**
 * Sends every provider delta immediately through Realtime's HTTP broadcast
 * endpoint. It deliberately does not wait for a WebSocket subscription and it
 * never merges adjacent deltas into a large visible block.
 */
export class LiveJobPublisher {
  private readonly client: SupabaseClient
  private readonly channel: RealtimeChannel | null
  private readonly inFlight = new Set<Promise<void>>()
  private readonly queue: LiveJobEvent[] = []
  private readonly drainWaiters: Array<() => void> = []
  private revision = 0
  private closing = false

  constructor(
    client: SupabaseClient,
    jobId: string,
    channelSecret = process.env.AGENT_CREDENTIAL_KEY,
  ) {
    this.client = client
    const channelName = liveJobChannelName(jobId, channelSecret)
    this.channel = channelName ? client.channel(channelName) : null
  }

  start(): void {
    // HTTP broadcast needs no channel subscription handshake.
  }

  publish(input: LiveJobEventInput): void {
    if (!this.channel || this.closing) return
    this.queue.push({ ...input, revision: ++this.revision })
    this.pump()
  }

  async close(): Promise<void> {
    if (this.closing) return this.waitForDrain()
    this.closing = true
    this.pump()
    await this.waitForDrain()
    if (!this.channel) return
    try { await this.client.removeChannel(this.channel) } catch {}
  }

  private pump(): void {
    while (this.channel
      && this.queue.length > 0
      && this.inFlight.size < MAX_IN_FLIGHT_BROADCASTS) {
      const event = this.queue.shift()
      if (!event) break
      this.launch(event)
    }
    this.resolveDrainWaiters()
  }

  private launch(event: LiveJobEvent): void {
    const task = this.send(event)
    this.inFlight.add(task)
    void task.finally(() => {
      this.inFlight.delete(task)
      this.pump()
      this.resolveDrainWaiters()
    })
  }

  private async send(event: LiveJobEvent): Promise<void> {
    if (!this.channel) return
    try {
      await this.channel.httpSend(LIVE_JOB_BROADCAST_EVENT, event)
    } catch {
      // Durable events remain the recovery source when a live broadcast fails.
    }
  }

  private waitForDrain(): Promise<void> {
    if (this.queue.length === 0 && this.inFlight.size === 0) return Promise.resolve()
    return new Promise(resolve => this.drainWaiters.push(resolve))
  }

  private resolveDrainWaiters(): void {
    if (this.queue.length > 0 || this.inFlight.size > 0) return
    for (const resolve of this.drainWaiters.splice(0)) resolve()
  }
}
