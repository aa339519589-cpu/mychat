import type { JsonObject } from './contracts'
import type { LiveJobEvent } from './live-events'

export type ParsedLiveDelta = {
  field: 'content' | 'thinking'
  payloadField: 'text' | 'thinking'
  value: string
}

export function resetEvent(kind: string, payload: JsonObject): boolean {
  return kind === 'job.retry_scheduled'
    || (kind === 'job.leased' && typeof payload.attempt === 'number' && payload.attempt > 1)
}

export function liveDelta(event: LiveJobEvent): ParsedLiveDelta | null {
  if (event.kind === 'text.delta' && typeof event.payload.text === 'string') {
    return { field: 'content', payloadField: 'text', value: event.payload.text }
  }
  if (event.kind === 'thinking.delta' && typeof event.payload.thinking === 'string') {
    return { field: 'thinking', payloadField: 'thinking', value: event.payload.thinking }
  }
  return null
}
