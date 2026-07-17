import {
  MAX_GENERATED_MEDIA_ITEMS,
  type GeneratedMedia,
} from '@/lib/generated-media'
import { isRecord } from '@/lib/unknown-value'
import { makeContentFilter, parseDsmlToolCalls, hasIncompleteDsmlToolCall } from './sanitize'
import type { Emit } from './events'
import {
  GenericResponseLimitError,
  MAX_GENERIC_ACCUMULATED_TEXT_CHARS,
  mediaFromContentPart,
} from './turn-response'
import { CallerOutputLimitReached } from './turn-stream'
import type { ModelMessage, ModelToolCall } from './types'

export type AccumulatedToolCall = { id: string; name: string; args: string }

export type TurnAccumulationResult = {
  assistantMessage: ModelMessage | null
  toolCalls: AccumulatedToolCall[]
  failed: false
  totalTokens: number
  content: string
  finishReason: string | null
  truncated: boolean
  leaked: boolean
  hasIncompleteToolCall: boolean
  reasoningContent: string
}

type TurnAccumulatorOptions = {
  generic: boolean
  model: string
  emit: Emit
  timingEnabled: boolean
  startedAt: number
  deferTextUntilTurnEnd?: boolean
  contentPolicy?: (input: { content: string; hasToolCalls: boolean }) => string
  maxOutputTokens?: number
  mediaBudget?: { remaining: number; seen: Set<string> }
}

const REASONING_EVENT_TYPES = new Set([
  'response.reasoning_text.delta',
  'response.reasoning_summary_text.delta',
  'response.reasoning_summary.delta',
])

function maximumOutputCharacters(maxOutputTokens: number | undefined): number {
  if (maxOutputTokens === undefined) return Number.POSITIVE_INFINITY
  return Math.max(
    32,
    Math.min(MAX_GENERIC_ACCUMULATED_TEXT_CHARS, Math.floor(maxOutputTokens) * 8),
  )
}

function reasoningValue(delta: Record<string, unknown>): unknown {
  for (const field of [
    'reasoning_content',
    'reasoning_text',
    'reasoning_summary',
    'reasoning_summary_text',
  ]) {
    if (delta[field]) return delta[field]
  }
  if (!isRecord(delta.reasoning)) return delta.reasoning
  return delta.reasoning.content ?? delta.reasoning.text ?? delta.reasoning.summary
}

export class TurnAccumulator {
  readonly pendingRemoteMedia: GeneratedMedia[] = []
  private readonly options: TurnAccumulatorOptions
  private readonly maximumOutputChars: number
  private readonly mediaBudget: { remaining: number; seen: Set<string> }
  private readonly filter = makeContentFilter()
  private readonly callMap: Record<number, AccumulatedToolCall> = {}
  private content = ''
  private rawContent = ''
  private totalTokens = 0
  private finishReason: string | null = null
  private reasoningContent = ''
  private accumulatedTextChars = 0
  private acceptedOutputChars = 0
  private firstEventAt: number | null = null
  private firstTextAt: number | null = null

  constructor(options: TurnAccumulatorOptions) {
    this.options = options
    this.maximumOutputChars = maximumOutputCharacters(options.maxOutputTokens)
    this.mediaBudget = options.mediaBudget ?? {
      remaining: MAX_GENERATED_MEDIA_ITEMS,
      seen: new Set<string>(),
    }
  }

  private boundedText(value: unknown): string {
    const text = String(value)
    if (this.options.generic) {
      this.accumulatedTextChars += text.length
      if (this.accumulatedTextChars > MAX_GENERIC_ACCUMULATED_TEXT_CHARS) {
        throw new GenericResponseLimitError()
      }
    }
    return text
  }

  private recordFirstText(): void {
    if (!this.options.timingEnabled || this.firstTextAt !== null) return
    this.firstTextAt = Date.now()
    console.info('[llm/timing] first text', {
      model: this.options.model,
      ms: this.firstTextAt - this.options.startedAt,
    })
  }

  private acceptText(value: unknown): void {
    if (typeof value !== 'string' || !value) return
    const bounded = this.boundedText(value)
    const remaining = this.maximumOutputChars - this.acceptedOutputChars
    const delta = bounded.slice(0, Math.max(0, remaining))
    const reachedCallerLimit = delta.length < bounded.length
    this.acceptedOutputChars += delta.length
    this.rawContent += delta
    const safe = this.filter.feed(delta)
    if (safe) {
      this.content += safe
      this.recordFirstText()
      if (!this.options.deferTextUntilTurnEnd) this.options.emit({ text: safe })
    }
    if (reachedCallerLimit) throw new CallerOutputLimitReached()
  }

  private acceptReasoning(value: unknown): void {
    if (!value) return
    const text = this.boundedText(value)
    if (!text) return
    this.reasoningContent += text
    this.options.emit({ thinking: text })
  }

  private acceptMedia(value: unknown): boolean {
    const media = mediaFromContentPart(value)
    if (!media) return false
    const key = `${media.type}:${media.url}`
    if (!this.mediaBudget.seen.has(key) && this.mediaBudget.remaining > 0) {
      this.mediaBudget.seen.add(key)
      this.mediaBudget.remaining--
      if (/^data:/i.test(media.url)) this.options.emit({ media })
      else this.pendingRemoteMedia.push(media)
    }
    return true
  }

  private handleContent(value: unknown): void {
    if (typeof value === 'string') {
      this.acceptText(value)
      return
    }
    if (Array.isArray(value)) {
      for (const part of value) this.handleContent(part)
      return
    }
    if (!isRecord(value) || this.acceptMedia(value)) return
    if (typeof value.text === 'string') this.acceptText(value.text)
    else if (typeof value.output_text === 'string') this.acceptText(value.output_text)
    if (Array.isArray(value.content)) this.handleContent(value.content)
  }

  private recordFirstEvent(value: Record<string, unknown>): void {
    if (!this.options.timingEnabled || this.firstEventAt !== null) return
    this.firstEventAt = Date.now()
    console.info('[llm/timing] first upstream event', {
      model: this.options.model,
      ms: this.firstEventAt - this.options.startedAt,
      type: value.type ?? (value.choices ? 'chat.completion.chunk' : typeof value),
    })
  }

  private handleResponsesApiEvent(value: Record<string, unknown>): boolean {
    if (typeof value.type !== 'string') return false
    if (REASONING_EVENT_TYPES.has(value.type)) {
      this.acceptReasoning(value.delta ?? value.text ?? '')
      return true
    }
    if (value.type === 'response.output_text.delta') {
      this.acceptText(value.delta ?? value.text ?? '')
      return true
    }
    return false
  }

  private acceptToolCalls(value: unknown): void {
    if (!Array.isArray(value)) return
    for (const [position, item] of value.entries()) {
      if (!isRecord(item)) continue
      const index = typeof item.index === 'number' ? item.index : position
      const call = this.callMap[index] ?? { id: '', name: '', args: '' }
      this.callMap[index] = call
      if (item.id) call.id = this.boundedText(item.id)
      const function_ = isRecord(item.function) ? item.function : null
      if (function_?.name) call.name += this.boundedText(function_.name)
      if (function_?.arguments) call.args += this.boundedText(function_.arguments)
    }
  }

  private handleChoice(choice: Record<string, unknown>): void {
    if (typeof choice.finish_reason === 'string') this.finishReason = choice.finish_reason
    const deltaValue = choice.delta ?? choice.message
    const delta = isRecord(deltaValue) ? deltaValue : {}
    this.acceptReasoning(reasoningValue(delta))
    this.handleContent(delta.content)
    this.handleContent(delta.images)
    this.handleContent(delta.videos)
    if (delta.image_url) this.acceptMedia({ type: 'image_url', image_url: delta.image_url })
    if (delta.video_url) this.acceptMedia({ type: 'video_url', video_url: delta.video_url })
    this.acceptToolCalls(delta.tool_calls)
  }

  handle = (value: unknown): void => {
    if (!isRecord(value)) return
    this.recordFirstEvent(value)
    if (this.handleResponsesApiEvent(value)) return
    const usage = isRecord(value.usage) ? value.usage : null
    if (typeof usage?.total_tokens === 'number') this.totalTokens = usage.total_tokens
    const choices = Array.isArray(value.choices) ? value.choices : []
    const choice = isRecord(choices[0]) ? choices[0] : null
    if (choice) {
      this.handleChoice(choice)
      return
    }
    if (Array.isArray(value.output)) {
      for (const output of value.output) this.handleContent(output)
    }
  }

  private flushVisibleTail(): void {
    const tail = this.filter.flush()
    if (!tail) return
    this.content += tail
    if (!this.options.deferTextUntilTurnEnd) this.options.emit({ text: tail })
  }

  private resolvedToolCalls(): AccumulatedToolCall[] {
    const calls = Object.values(this.callMap).filter(call => call.name)
    if (calls.length > 0) return calls
    return parseDsmlToolCalls(this.rawContent)
  }

  private assistantMessage(
    toolCalls: AccumulatedToolCall[],
    visibleContent: string,
  ): ModelMessage | null {
    if (toolCalls.length === 0) return null
    return {
      role: 'assistant',
      content: visibleContent || '',
      ...(this.reasoningContent ? { reasoning_content: this.reasoningContent } : {}),
      tool_calls: toolCalls.map<ModelToolCall>(call => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.args || '{}' },
      })),
    }
  }

  finish(input: { sawDone: boolean; callerLimitReached: boolean }): TurnAccumulationResult {
    if (input.callerLimitReached) this.finishReason = 'caller_limit'
    this.flushVisibleTail()
    const toolCalls = this.resolvedToolCalls()
    const visibleContent = this.options.contentPolicy?.({
      content: this.content,
      hasToolCalls: toolCalls.length > 0,
    }) ?? this.content
    if (this.options.deferTextUntilTurnEnd && visibleContent) {
      this.options.emit({ text: visibleContent })
    }
    return {
      assistantMessage: this.assistantMessage(toolCalls, visibleContent),
      toolCalls,
      failed: false,
      totalTokens: this.totalTokens,
      content: visibleContent,
      finishReason: this.finishReason,
      truncated: !this.finishReason && !input.sawDone && this.rawContent.length > 0,
      leaked: this.content.length < this.rawContent.length,
      hasIncompleteToolCall: toolCalls.length === 0 && hasIncompleteDsmlToolCall(this.rawContent),
      reasoningContent: this.reasoningContent,
    }
  }
}
