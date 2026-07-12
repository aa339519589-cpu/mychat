import { log } from '@/lib/logger'
import type { GenerationEvent, GenerationRecord, GenerationStatus } from './types'

type Listener = (event: GenerationEvent) => void

type RuntimeEntry = {
  record: GenerationRecord
  abort: AbortController
  listeners: Set<Listener>
  /** sequence of last event each subscriber may have; used for resume */
}

const globalKey = '__mychat_generation_runtime__'
const runtime: Map<string, RuntimeEntry> =
  (globalThis as any)[globalKey] ?? ((globalThis as any)[globalKey] = new Map())

function now() { return Date.now() }

export function createGeneration(input: {
  id: string
  userId: string
  conversationId: string
  assistantMessageId: string
}): RuntimeEntry {
  const existing = runtime.get(input.id)
  if (existing) return existing
  const record: GenerationRecord = {
    id: input.id,
    userId: input.userId,
    conversationId: input.conversationId,
    assistantMessageId: input.assistantMessageId,
    status: 'queued',
    content: '',
    thinking: '',
    sequence: 0,
    createdAt: now(),
    updatedAt: now(),
  }
  const entry: RuntimeEntry = {
    record,
    abort: new AbortController(),
    listeners: new Set(),
  }
  runtime.set(input.id, entry)
  log.info('generation', 'task created', {
    generationId: input.id,
    conversationId: input.conversationId,
    assistantMessageId: input.assistantMessageId,
    status: record.status,
  })
  return entry
}

export function getGeneration(id: string): RuntimeEntry | undefined {
  return runtime.get(id)
}

export function getGenerationForUser(id: string, userId: string): RuntimeEntry | undefined {
  const entry = runtime.get(id)
  if (!entry || entry.record.userId !== userId) return undefined
  return entry
}

export function listRunningForConversation(userId: string, conversationId: string): GenerationRecord[] {
  const out: GenerationRecord[] = []
  for (const entry of runtime.values()) {
    if (entry.record.userId === userId
      && entry.record.conversationId === conversationId
      && (entry.record.status === 'running' || entry.record.status === 'queued')) {
      out.push({ ...entry.record })
    }
  }
  return out
}

function emit(entry: RuntimeEntry, partial: Omit<GenerationEvent, 'generationId' | 'conversationId' | 'assistantMessageId' | 'sequence' | 'status'> & { status?: GenerationStatus }) {
  entry.record.sequence += 1
  entry.record.updatedAt = now()
  if (partial.status) entry.record.status = partial.status
  const event: GenerationEvent = {
    generationId: entry.record.id,
    conversationId: entry.record.conversationId,
    assistantMessageId: entry.record.assistantMessageId,
    sequence: entry.record.sequence,
    content: entry.record.content,
    thinking: entry.record.thinking,
    ...partial,
    status: partial.status ?? entry.record.status,
  }
  for (const listener of entry.listeners) {
    try { listener(event) } catch { /* ignore subscriber errors */ }
  }
  return event
}

export function appendText(id: string, delta: string) {
  const entry = runtime.get(id)
  if (!entry) return
  entry.record.content += delta
  return emit(entry, { type: 'text', delta })
}

export function appendThinking(id: string, delta: string) {
  const entry = runtime.get(id)
  if (!entry) return
  entry.record.thinking += delta
  return emit(entry, { type: 'thinking', delta })
}

export function setStatus(id: string, status: GenerationStatus, error?: string) {
  const entry = runtime.get(id)
  if (!entry) return
  if (error) entry.record.error = error
  entry.record.status = status
  log.info('generation', 'status', {
    generationId: id,
    conversationId: entry.record.conversationId,
    assistantMessageId: entry.record.assistantMessageId,
    status,
    sequence: entry.record.sequence,
    error,
  })
  return emit(entry, { type: status === 'completed' || status === 'failed' || status === 'cancelled' ? 'done' : 'status', status, error })
}

export function subscribe(id: string, listener: Listener, afterSequence = 0): (() => void) | null {
  const entry = runtime.get(id)
  if (!entry) return null
  entry.listeners.add(listener)
  log.info('generation', 'stream connected', {
    generationId: id,
    conversationId: entry.record.conversationId,
    afterSequence,
    status: entry.record.status,
    sequence: entry.record.sequence,
  })
  // Catch-up snapshot for resume
  if (entry.record.sequence > afterSequence || entry.record.content || entry.record.thinking) {
    listener({
      generationId: entry.record.id,
      conversationId: entry.record.conversationId,
      assistantMessageId: entry.record.assistantMessageId,
      sequence: entry.record.sequence,
      type: 'status',
      status: entry.record.status,
      content: entry.record.content,
      thinking: entry.record.thinking,
      error: entry.record.error,
    })
  }
  return () => {
    entry.listeners.delete(listener)
    log.info('generation', 'stream disconnected', {
      generationId: id,
      conversationId: entry.record.conversationId,
      status: entry.record.status,
      sequence: entry.record.sequence,
    })
  }
}

/** User explicit cancel only. */
export function cancelGeneration(id: string, userId: string): boolean {
  const entry = getGenerationForUser(id, userId)
  if (!entry) return false
  if (entry.record.status === 'completed' || entry.record.status === 'failed' || entry.record.status === 'cancelled') {
    return true
  }
  entry.abort.abort()
  setStatus(id, 'cancelled')
  log.info('generation', 'task cancelled', {
    generationId: id,
    conversationId: entry.record.conversationId,
    assistantMessageId: entry.record.assistantMessageId,
  })
  return true
}

export function getAbortSignal(id: string): AbortSignal | undefined {
  return runtime.get(id)?.abort.signal
}

/** Cleanup finished entries after a while to avoid unbounded memory. */
export function maybeGc(id: string) {
  const entry = runtime.get(id)
  if (!entry) return
  if (entry.record.status === 'running' || entry.record.status === 'queued') return
  if (entry.listeners.size > 0) return
  setTimeout(() => {
    const cur = runtime.get(id)
    if (!cur) return
    if (cur.listeners.size > 0) return
    if (cur.record.status === 'running' || cur.record.status === 'queued') return
    runtime.delete(id)
  }, 5 * 60_000)
}
