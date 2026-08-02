import type { ChatEvent } from '@/lib/llm/events'
import type { JobEventDraft, JsonObject, JsonValue } from './contracts'
import type { JobExecutionContext } from './worker'

const FLUSH_INTERVAL_MS = 16
const FLUSH_BATCH_SIZE = 12
const MAX_TEXT_DELTA_CHARS = 24
const MAX_THINKING_DELTA_CHARS = 256

function jsonObject(value: object): JsonObject {
  const parsed: unknown = JSON.parse(JSON.stringify(value))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  return parsed as JsonObject
}

function splitText(value: string, maximum: number): string[] {
  if (!value) return []
  const characters = Array.from(value)
  const chunks: string[] = []
  for (let index = 0; index < characters.length; index += maximum) {
    chunks.push(characters.slice(index, index + maximum).join(''))
  }
  return chunks
}

function eventDrafts(event: ChatEvent): JobEventDraft[] {
  if ('text' in event) {
    return splitText(event.text, MAX_TEXT_DELTA_CHARS)
      .map(text => ({ kind: 'text.delta', payload: { text } }))
  }
  if ('thinking' in event) {
    return splitText(event.thinking, MAX_THINKING_DELTA_CHARS)
      .map(thinking => ({ kind: 'thinking.delta', payload: { thinking } }))
  }
  if ('media' in event) return [{ kind: 'media.uploaded', payload: { media: jsonObject(event.media) } }]
  if ('memory' in event) return [{ kind: 'tool.memory', payload: { memory: jsonObject(event.memory) } }]
  if ('search' in event) return [{ kind: 'tool.search', payload: { search: jsonObject(event.search) } }]
  if ('imageSummary' in event) {
    return [{ kind: 'context.image_summary', payload: { imageSummary: jsonObject(event.imageSummary) } }]
  }
  if ('step' in event) return [{ kind: 'agent.step', payload: { step: jsonObject(event.step) } }]
  if ('plan' in event) return [{ kind: 'agent.plan', payload: { plan: jsonObject(event.plan) } }]
  if ('error' in event) return [{ kind: 'job.warning', payload: { message: event.error } }]
  return []
}

function deltaValue(event: JobEventDraft): { field: 'text' | 'thinking'; value: string } | null {
  if (event.kind === 'text.delta' && typeof event.payload.text === 'string') {
    return { field: 'text', value: event.payload.text }
  }
  if (event.kind === 'thinking.delta' && typeof event.payload.thinking === 'string') {
    return { field: 'thinking', value: event.payload.thinking }
  }
  return null
}

function deltaLimit(field: 'text' | 'thinking'): number {
  return field === 'text' ? MAX_TEXT_DELTA_CHARS : MAX_THINKING_DELTA_CHARS
}

function materializedText(
  progress: JsonObject | undefined,
  field: 'content' | 'thinking',
  partsField: 'contentParts' | 'thinkingParts',
): string {
  const direct = progress?.[field]
  if (typeof direct === 'string') return direct
  const parts = progress?.[partsField]
  if (!Array.isArray(parts)) return ''
  const text: string[] = []
  for (const part of parts) {
    if (!part || typeof part !== 'object' || Array.isArray(part)
      || part.type !== 'text' || typeof part.text !== 'string') return ''
    text.push(part.text)
  }
  return text.join('')
}

/**
 * Bridges synchronous model deltas to the durable, fenced event log. Visible
 * text is kept in small bounded events, and only one database append is allowed
 * in flight so fast providers cannot build a seconds-long RPC promise chain.
 */
export class JobEventWriter {
  private readonly context: JobExecutionContext
  private queue: JobEventDraft[] = []
  private chain: Promise<void> = Promise.resolve()
  private failure: unknown = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private fullText = ''
  private fullThinking = ''
  private firstTextFlushed = false
  private flushing = false

  constructor(context: JobExecutionContext) {
    this.context = context
    const progress = context.job.checkpoint?.progress
    this.fullText = materializedText(progress, 'content', 'contentParts')
    this.fullThinking = materializedText(progress, 'thinking', 'thinkingParts')
    this.firstTextFlushed = this.fullText.length > 0
  }

  emit = (event: ChatEvent): void => {
    const isText = 'text' in event && event.text.length > 0
    if ('text' in event) this.fullText += event.text
    if ('thinking' in event) this.fullThinking += event.thinking
    for (const draft of eventDrafts(event)) this.enqueueDraft(draft)
    if (this.queue.length === 0) return
    if (isText && !this.firstTextFlushed) {
      this.firstTextFlushed = true
      this.scheduleFlush(0)
    } else if (this.queue.length >= FLUSH_BATCH_SIZE) {
      this.scheduleFlush(0)
    } else if (!this.timer) {
      this.scheduleFlush(FLUSH_INTERVAL_MS)
    }
  }

  snapshot(extra: JsonObject = {}): JsonObject {
    return {
      content: this.fullText,
      thinking: this.fullThinking,
      contentParts: this.fullText ? [{ type: 'text', text: this.fullText }] : [],
      thinkingParts: this.fullThinking ? [{ type: 'text', text: this.fullThinking }] : [],
      ...extra,
    }
  }

  text(): string {
    return this.fullText
  }

  thinking(): string {
    return this.fullThinking
  }

  async append(kind: string, payload: JsonObject, idempotencyKey?: string): Promise<void> {
    this.queue.push({ kind, payload, ...(idempotencyKey ? { idempotencyKey } : {}) })
    await this.drainEvents()
  }

  async checkpoint(input: {
    phase: string
    data: JsonObject
    resumable: boolean
    extraProgress?: JsonObject
  }): Promise<void> {
    await this.drainEvents()
    await this.context.checkpoint({
      phase: input.phase,
      checkpoint: input.data,
      progress: this.snapshot(input.extraProgress),
      resumable: input.resumable,
    })
  }

  async drain(): Promise<void> {
    await this.drainEvents()
    if (this.failure) throw this.failure
    this.context.assertAuthority()
  }

  private enqueueDraft(draft: JobEventDraft): void {
    const current = deltaValue(draft)
    const previous = this.queue.at(-1)
    const previousDelta = previous ? deltaValue(previous) : null
    if (current && previous && previousDelta?.field === current.field
      && previousDelta.value.length + current.value.length <= deltaLimit(current.field)) {
      previous.payload[current.field] = `${previousDelta.value}${current.value}`
      return
    }
    this.queue.push(draft)
  }

  private scheduleFlush(milliseconds: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, milliseconds)
  }

  private async drainEvents(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    while (!this.failure && (this.queue.length > 0 || this.flushing)) {
      await this.flush()
      await this.chain
    }
    if (this.failure) throw this.failure
  }

  private flush(): Promise<void> {
    if (this.failure || this.flushing || this.queue.length === 0) return this.chain
    const batch = this.queue.splice(0, FLUSH_BATCH_SIZE)
    this.flushing = true
    this.chain = this.chain.then(async () => {
      this.context.assertAuthority()
      await this.context.appendEvents(batch)
    }).catch(error => {
      this.failure = error
    }).finally(() => {
      this.flushing = false
      if (!this.failure && this.queue.length > 0) this.scheduleFlush(0)
    })
    return this.chain
  }
}

export function jsonResult(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}
