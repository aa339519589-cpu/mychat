import type { ChatEvent } from '@/lib/llm/events'
import type { JobEventDraft, JsonObject, JsonValue } from './contracts'
import type { JobExecutionContext } from './worker'

const FLUSH_INTERVAL_MS = 100
const FLUSH_BATCH_SIZE = 32
const MAX_COALESCED_DELTA_CHARS = 4_096

function jsonObject(value: object): JsonObject {
  const parsed: unknown = JSON.parse(JSON.stringify(value))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  return parsed as JsonObject
}

function eventDraft(event: ChatEvent): JobEventDraft | null {
  if ('text' in event) return { kind: 'text.delta', payload: { text: event.text } }
  if ('thinking' in event) return { kind: 'thinking.delta', payload: { thinking: event.thinking } }
  if ('media' in event) return { kind: 'media.uploaded', payload: { media: jsonObject(event.media) } }
  if ('memory' in event) return { kind: 'tool.memory', payload: { memory: jsonObject(event.memory) } }
  if ('search' in event) return { kind: 'tool.search', payload: { search: jsonObject(event.search) } }
  if ('imageSummary' in event) {
    return { kind: 'context.image_summary', payload: { imageSummary: jsonObject(event.imageSummary) } }
  }
  if ('step' in event) return { kind: 'agent.step', payload: { step: jsonObject(event.step) } }
  if ('plan' in event) return { kind: 'agent.plan', payload: { plan: jsonObject(event.plan) } }
  if ('error' in event) return { kind: 'job.warning', payload: { message: event.error } }
  return null
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

/**
 * Bridges synchronous model deltas to the durable, fenced event log. Adjacent
 * deltas are coalesced, writes are serialized, and drain propagates any lost
 * fence or storage failure before the handler can finalize.
 */
export class JobEventWriter {
  private readonly context: JobExecutionContext
  private queue: JobEventDraft[] = []
  private chain: Promise<void> = Promise.resolve()
  private failure: unknown = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private fullText = ''
  private fullThinking = ''

  constructor(context: JobExecutionContext) {
    this.context = context
  }

  emit = (event: ChatEvent): void => {
    if ('text' in event) this.fullText += event.text
    if ('thinking' in event) this.fullThinking += event.thinking
    const draft = eventDraft(event)
    if (!draft) return
    const current = deltaValue(draft)
    const previous = this.queue.at(-1)
    const previousDelta = previous ? deltaValue(previous) : null
    if (current && previous && previousDelta?.field === current.field
      && previousDelta.value.length + current.value.length <= MAX_COALESCED_DELTA_CHARS) {
      previous.payload[current.field] = `${previousDelta.value}${current.value}`
    } else {
      this.queue.push(draft)
    }
    if (this.queue.length >= FLUSH_BATCH_SIZE) this.scheduleFlush(0)
    else if (!this.timer) this.scheduleFlush(FLUSH_INTERVAL_MS)
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
    await this.flush()
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
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    await this.drainEvents()
    if (this.failure) throw this.failure
    this.context.assertAuthority()
  }

  private scheduleFlush(milliseconds: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, milliseconds)
  }

  private async drainEvents(): Promise<void> {
    await this.flush()
    await this.chain
    if (this.failure) throw this.failure
  }

  private flush(): Promise<void> {
    if (this.failure || this.queue.length === 0) return this.chain
    const batch = this.queue.splice(0, FLUSH_BATCH_SIZE)
    this.chain = this.chain.then(async () => {
      this.context.assertAuthority()
      await this.context.appendEvents(batch)
    }).catch(error => {
      this.failure = error
    })
    if (this.queue.length > 0) this.scheduleFlush(0)
    return this.chain
  }
}

export function jsonResult(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}
