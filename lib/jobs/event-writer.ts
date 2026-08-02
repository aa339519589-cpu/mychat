import type { ChatEvent } from '@/lib/llm/events'
import { createAdminClient } from '@/lib/supabase/admin'
import type { JobEventDraft, JsonObject, JsonValue } from './contracts'
import { LiveJobPublisher, type LiveJobEventInput } from './live-events'
import type { JobExecutionContext } from './worker'

const FLUSH_INTERVAL_MS = 12
const FLUSH_BATCH_SIZE = 16
const MAX_COALESCED_DELTA_CHARS = 64

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

function defaultLiveRelay(context: JobExecutionContext): {
  publisher: LiveJobPublisher | null
  emit?: (event: LiveJobEventInput) => void
} {
  try {
    const client = createAdminClient()
    if (!client) return { publisher: null }
    const publisher = new LiveJobPublisher(client, context.job.id)
    publisher.start()
    return { publisher, emit: event => publisher.publish(event) }
  } catch {
    return { publisher: null }
  }
}

/**
 * Sends raw text/thinking deltas through the live relay first, then appends all
 * events to the fenced durable log. Database reads stay on recovery paths.
 */
export class JobEventWriter {
  private readonly context: JobExecutionContext
  private readonly livePublisher: LiveJobPublisher | null
  private readonly onLiveEvent?: (event: LiveJobEventInput) => void
  private queue: JobEventDraft[] = []
  private chain: Promise<void> = Promise.resolve()
  private failure: unknown = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private fullText = ''
  private fullThinking = ''
  private firstTextFlushed = false

  constructor(
    context: JobExecutionContext,
    onLiveEvent?: (event: LiveJobEventInput) => void,
  ) {
    this.context = context
    const relay = onLiveEvent ? { publisher: null, emit: onLiveEvent } : defaultLiveRelay(context)
    this.livePublisher = relay.publisher
    this.onLiveEvent = relay.emit
    const progress = context.job.checkpoint?.progress
    this.fullText = materializedText(progress, 'content', 'contentParts')
    this.fullThinking = materializedText(progress, 'thinking', 'thinkingParts')
    this.firstTextFlushed = this.fullText.length > 0
  }

  emit = (event: ChatEvent): void => {
    const textOffset = this.fullText.length
    const thinkingOffset = this.fullThinking.length
    const isText = 'text' in event && event.text.length > 0
    if ('text' in event) this.fullText += event.text
    if ('thinking' in event) this.fullThinking += event.thinking
    const draft = eventDraft(event)
    if (!draft) return
    const current = deltaValue(draft)
    if (current) {
      this.publishLive({
        kind: draft.kind,
        payload: draft.payload,
        offset: current.field === 'text' ? textOffset : thinkingOffset,
      })
    }
    const previous = this.queue.at(-1)
    const previousDelta = previous ? deltaValue(previous) : null
    if (current && previous && previousDelta?.field === current.field
      && previousDelta.value.length + current.value.length <= MAX_COALESCED_DELTA_CHARS) {
      previous.payload[current.field] = `${previousDelta.value}${current.value}`
    } else {
      this.queue.push(draft)
    }
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
    await this.closeLive()
    if (this.failure) throw this.failure
    this.context.assertAuthority()
  }

  async closeLive(): Promise<void> {
    await this.livePublisher?.close()
  }

  private publishLive(event: LiveJobEventInput): void {
    try { this.onLiveEvent?.(event) } catch {}
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
