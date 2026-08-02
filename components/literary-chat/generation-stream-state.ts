import {
  normalizeGeneratedMedia,
  normalizeGeneratedMediaList,
  type GeneratedMedia,
} from '@/lib/generated-media'
import type { JobStreamEnvelope } from './job-stream-client'

export type GenerationStreamState = {
  content: string
  thinking: string
  media: GeneratedMedia[]
}

export function createGenerationStreamState(): GenerationStreamState {
  return { content: '', thinking: '', media: [] }
}

function resetForRetry(event: JobStreamEnvelope, state: GenerationStreamState): void {
  const retried = event.kind === 'job.retry_scheduled'
    || (event.kind === 'job.leased'
      && typeof event.payload.attempt === 'number'
      && event.payload.attempt > 1)
  if (!retried) return
  state.content = ''
  state.thinking = ''
  state.media.splice(0, state.media.length)
}

function applySnapshot(event: JobStreamEnvelope, state: GenerationStreamState): boolean {
  if (event.kind !== 'job.snapshot') return false
  if (typeof event.payload.content === 'string') state.content = event.payload.content
  if (typeof event.payload.thinking === 'string') state.thinking = event.payload.thinking
  if (Array.isArray(event.payload.media)) {
    state.media.splice(0, state.media.length, ...normalizeGeneratedMediaList(event.payload.media))
  }
  return true
}

function applyDelta(event: JobStreamEnvelope, state: GenerationStreamState): boolean {
  if (event.kind === 'text.delta' && typeof event.payload.text === 'string') {
    state.content += event.payload.text
    return true
  }
  if (event.kind === 'thinking.delta' && typeof event.payload.thinking === 'string') {
    state.thinking += event.payload.thinking
    return true
  }
  return false
}

function applyMedia(event: JobStreamEnvelope, state: GenerationStreamState): void {
  if (event.kind !== 'media.uploaded') return
  const item = normalizeGeneratedMedia(event.payload.media)
  if (!item) return
  const duplicate = state.media.some(existing => existing.type === item.type && existing.url === item.url)
  if (!duplicate) state.media.push(item)
}

export function applyGenerationStreamEvent(
  event: JobStreamEnvelope,
  state: GenerationStreamState,
): void {
  resetForRetry(event, state)
  if (applySnapshot(event, state)) return
  if (applyDelta(event, state)) return
  applyMedia(event, state)
}
