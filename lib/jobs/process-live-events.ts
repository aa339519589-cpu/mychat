import { isJsonValue } from './contracts'
import type { LiveJobEvent } from './live-events'

const MESSAGE_TYPE = 'mychat.job.live.v1'
const MAX_PENDING_JOBS = 64
const MAX_PENDING_EVENTS = 64
const MAX_PENDING_AGE_MS = 60_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function uuid(value: unknown): boolean { return typeof value === 'string' && UUID.test(value) }
type Listener = (event: LiveJobEvent, publishedAt: number) => void
export type ProcessLiveMessage = {
  type: typeof MESSAGE_TYPE
  jobId: string
  event: LiveJobEvent
  publishedAt: number
}
type Relay = {
  listening: boolean
  listeners: Map<string, Set<Listener>>
  pending: Map<string, ProcessLiveMessage[]>
}
const shared = globalThis as typeof globalThis & { __mychatProcessLiveRelay?: Relay }
function relay(): Relay {
  return shared.__mychatProcessLiveRelay ??= { listening: false, listeners: new Map(), pending: new Map() }
}

export function parseProcessLiveMessage(value: unknown): ProcessLiveMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Partial<ProcessLiveMessage>
  if (item.type !== MESSAGE_TYPE || !uuid(item.jobId)
    || !Number.isSafeInteger(item.publishedAt) || Number(item.publishedAt) <= 0
    || !validProcessEvent(item.event)) return null
  return item as ProcessLiveMessage
}

function validProcessEvent(event: LiveJobEvent | undefined): boolean {
  if (!event || typeof event !== 'object' || Array.isArray(event)
    || typeof event.kind !== 'string' || event.kind.length > 128
    || !Number.isSafeInteger(event.revision) || event.revision < 1) return false
  return Boolean(event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
    && isJsonValue(event.payload)
    && validProcessOffset(event.offset)
    && (event.streamId === undefined || uuid(event.streamId)))
}

function validProcessOffset(offset: number | undefined): boolean {
  return offset === undefined || (Number.isSafeInteger(offset) && offset >= 0)
}

/** Only the supervisor's private Node IPC pipe can feed this relay. */
export function receiveProcessLiveMessage(value: unknown): void {
  const item = parseProcessLiveMessage(value)
  if (!item) return
  const state = relay()
  const listeners = state.listeners.get(item.jobId)
  if (listeners?.size) {
    for (const listener of listeners) listener(item.event, item.publishedAt)
    return
  }
  for (const [jobId, events] of state.pending) {
    if ((events[0]?.publishedAt ?? 0) < Date.now() - MAX_PENDING_AGE_MS) state.pending.delete(jobId)
  }
  // Keep the first events while the authenticated stream lease is acquired.
  // Reconnection and overflow still recover through the durable event log.
  if (!state.pending.has(item.jobId) && state.pending.size >= MAX_PENDING_JOBS) {
    state.pending.delete(state.pending.keys().next().value ?? '')
  }
  const pending = state.pending.get(item.jobId) ?? []
  if (pending.length < MAX_PENDING_EVENTS) pending.push(item)
  state.pending.set(item.jobId, pending)
}

export function startProcessLiveRelay(): void {
  const state = relay()
  if (state.listening || process.env.MYCHAT_LOCAL_LIVE_RELAY !== '1') return
  state.listening = true
  process.on('message', receiveProcessLiveMessage)
}

export function subscribeProcessLiveEvents(jobId: string, listener: Listener): () => void {
  startProcessLiveRelay()
  const state = relay()
  const listeners = state.listeners.get(jobId) ?? new Set<Listener>()
  listeners.add(listener)
  state.listeners.set(jobId, listeners)
  const pending = state.pending.get(jobId) ?? []
  state.pending.delete(jobId)
  for (const item of pending) {
    if (item.publishedAt >= Date.now() - MAX_PENDING_AGE_MS) listener(item.event, item.publishedAt)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) state.listeners.delete(jobId)
  }
}

/** No timers, batches, HTTP round trips or database acknowledgements. */
export function publishProcessLiveEvent(jobId: string, event: LiveJobEvent): void {
  if (process.env.MYCHAT_LOCAL_LIVE_RELAY !== '1' || !process.connected || !process.send) return
  try {
    process.send({ type: MESSAGE_TYPE, jobId, event, publishedAt: Date.now() }, () => undefined)
  } catch { /* Cross-host Realtime and the durable log remain independent fallbacks. */ }
}
