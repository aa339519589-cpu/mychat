import type { GeneratedMedia } from '@/lib/generated-media'
import { tokenUsageTotal, type TokenUsage } from '@/lib/token-usage'
import { isRecord } from '@/lib/unknown-value'
import type { Emit } from './events'
import { makeContentFilter } from './sanitize'
import {
  GenericResponseLimitError,
  MAX_GENERIC_ACCUMULATED_TEXT_CHARS,
} from './turn-response'
import { CallerOutputLimitReached } from './turn-stream'
import type {
  AccumulatedToolCall,
  TurnAccumulationResult,
} from './turn-accumulator'
import type { ModelMessage, ModelToolCall } from './types'

type AnthropicAccumulatorOptions = {
  model: string
  emit: Emit
  timingEnabled: boolean
  startedAt: number
  deferTextUntilTurnEnd?: boolean
  lowLatencyTextStreaming?: boolean
  contentPolicy?: (input: { content: string; hasToolCalls: boolean }) => string
  maxOutputTokens?: number
}

type TextBlock = { type: 'text'; text: string }
type ThinkingBlock = { type: 'thinking'; thinking: string; signature: string }
type RedactedThinkingBlock = { type: 'redacted_thinking'; data: string }
type ToolUseBlock = { type: 'tool_use'; id: string; name: string; args: string; initialInput: unknown }
type BlockState = TextBlock | ThinkingBlock | RedactedThinkingBlock | ToolUseBlock

function maximumOutputCharacters(maxOutputTokens: number | undefined): number {
  if (maxOutputTokens === undefined) return MAX_GENERIC_ACCUMULATED_TEXT_CHARS
  return Math.max(32, Math.min(MAX_GENERIC_ACCUMULATED_TEXT_CHARS, Math.floor(maxOutputTokens) * 8))
}

function tokenCount(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null
}

function stopReason(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (value === 'max_tokens') return 'length'
  if (value === 'tool_use') return 'tool_calls'
  if (value === 'end_turn' || value === 'stop_sequence' || value === 'refusal') return 'stop'
  return value
}

function errorMessage(value: unknown): string | null {
  if (!isRecord(value)) return null
  const error = isRecord(value.error) ? value.error : value
  if (typeof error.message !== 'string' || !error.message.trim()) return null
  const type = typeof error.type === 'string' ? error.type : ''
  return type ? `${error.message.trim()}（${type}）` : error.message.trim()
}

function parsedToolInput(value: string, fallback: unknown): unknown {
  if (value) {
    try { return JSON.parse(value) as unknown }
    catch { return {} }
  }
  return fallback ?? {}
}

function validToolArguments(value: string): boolean {
  if (!value) return true
  try { JSON.parse(value); return true }
  catch { return false }
}

export class AnthropicTurnAccumulator {
  readonly pendingRemoteMedia: GeneratedMedia[] = []
  private readonly options: AnthropicAccumulatorOptions
  private readonly maximumOutputChars: number
  private readonly filter: ReturnType<typeof makeContentFilter>
  private readonly blocks = new Map<number, BlockState>()
  private content = ''
  private rawContent = ''
  private reasoningContent = ''
  private finishReason: string | null = null
  private streamError: string | null = null
  private inputTokens: number | null = null
  private outputTokens: number | null = null
  private acceptedOutputChars = 0
  private accumulatedTextChars = 0
  private firstEventAt: number | null = null
  private firstTextAt: number | null = null

  constructor(options: AnthropicAccumulatorOptions) {
    this.options = options
    this.maximumOutputChars = maximumOutputCharacters(options.maxOutputTokens)
    this.filter = makeContentFilter({ lowLatency: options.lowLatencyTextStreaming })
  }

  private boundedText(value: unknown): string {
    const text = String(value)
    this.accumulatedTextChars += text.length
    if (this.accumulatedTextChars > MAX_GENERIC_ACCUMULATED_TEXT_CHARS) {
      throw new GenericResponseLimitError()
    }
    return text
  }

  private recordFirstEvent(value: Record<string, unknown>): void {
    if (!this.options.timingEnabled || this.firstEventAt !== null) return
    this.firstEventAt = Date.now()
    console.info('[llm/timing] first upstream event', {
      model: this.options.model,
      ms: this.firstEventAt - this.options.startedAt,
      type: value.type ?? typeof value,
    })
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
    if (typeof value !== 'string' || !value) return
    const text = this.boundedText(value)
    this.reasoningContent += text
    this.options.emit({ thinking: text })
  }

  private acceptUsage(value: unknown): void {
    if (!isRecord(value)) return
    const input = tokenCount(value.input_tokens)
    const output = tokenCount(value.output_tokens)
    if (input !== null) this.inputTokens = input
    if (output !== null) this.outputTokens = output
  }

  private startBlock(index: number, value: unknown): void {
    if (!isRecord(value) || typeof value.type !== 'string') return
    if (value.type === 'text') {
      const text = typeof value.text === 'string' ? value.text : ''
      this.blocks.set(index, { type: 'text', text })
      this.acceptText(text)
      return
    }
    if (value.type === 'thinking') {
      const thinking = typeof value.thinking === 'string' ? value.thinking : ''
      const signature = typeof value.signature === 'string' ? value.signature : ''
      this.blocks.set(index, { type: 'thinking', thinking, signature })
      this.acceptReasoning(thinking)
      return
    }
    if (value.type === 'redacted_thinking') {
      this.blocks.set(index, {
        type: 'redacted_thinking',
        data: typeof value.data === 'string' ? value.data : '',
      })
      return
    }
    if (value.type === 'tool_use') {
      this.blocks.set(index, {
        type: 'tool_use',
        id: typeof value.id === 'string' ? value.id : '',
        name: typeof value.name === 'string' ? value.name : '',
        args: '',
        initialInput: value.input,
      })
    }
  }

  private applyDelta(index: number, value: unknown): void {
    if (!isRecord(value) || typeof value.type !== 'string') return
    const block = this.blocks.get(index)
    if (value.type === 'text_delta' && typeof value.text === 'string') {
      if (block?.type === 'text') block.text += value.text
      else this.blocks.set(index, { type: 'text', text: value.text })
      this.acceptText(value.text)
      return
    }
    if (value.type === 'thinking_delta' && typeof value.thinking === 'string') {
      if (block?.type === 'thinking') block.thinking += value.thinking
      else this.blocks.set(index, { type: 'thinking', thinking: value.thinking, signature: '' })
      this.acceptReasoning(value.thinking)
      return
    }
    if (value.type === 'signature_delta' && typeof value.signature === 'string') {
      if (block?.type === 'thinking') block.signature += value.signature
      return
    }
    if (value.type === 'input_json_delta' && typeof value.partial_json === 'string') {
      if (block?.type === 'tool_use') block.args += this.boundedText(value.partial_json)
    }
  }

  private acceptMessage(value: Record<string, unknown>): void {
    this.acceptUsage(value.usage)
    const reason = stopReason(value.stop_reason)
    if (reason) this.finishReason = reason
    if (!Array.isArray(value.content)) return
    for (const [index, block] of value.content.entries()) this.startBlock(index, block)
  }

  handle = (value: unknown): void => {
    if (!isRecord(value)) return
    this.recordFirstEvent(value)
    const error = errorMessage(value)
    if (value.type === 'error' && error) this.streamError = error

    if (value.type === 'message_start' && isRecord(value.message)) {
      this.acceptUsage(value.message.usage)
      return
    }
    if (value.type === 'content_block_start' && typeof value.index === 'number') {
      this.startBlock(value.index, value.content_block)
      return
    }
    if (value.type === 'content_block_delta' && typeof value.index === 'number') {
      this.applyDelta(value.index, value.delta)
      return
    }
    if (value.type === 'message_delta') {
      this.acceptUsage(value.usage)
      const delta = isRecord(value.delta) ? value.delta : null
      const reason = stopReason(delta?.stop_reason)
      if (reason) this.finishReason = reason
      return
    }
    if (value.type === 'message' || Array.isArray(value.content)) this.acceptMessage(value)
  }

  private flushVisibleTail(): void {
    const tail = this.filter.flush()
    if (!tail) return
    this.content += tail
    if (!this.options.deferTextUntilTurnEnd) this.options.emit({ text: tail })
  }

  private resolvedToolCalls(): AccumulatedToolCall[] {
    return [...this.blocks.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, block]) => block)
      .filter((block): block is ToolUseBlock => block.type === 'tool_use' && Boolean(block.name))
      .map(block => ({
        id: block.id,
        name: block.name,
        args: block.args || JSON.stringify(block.initialInput ?? {}),
      }))
  }

  private preservedContent(): Record<string, unknown>[] {
    const content: Record<string, unknown>[] = []
    for (const [, block] of [...this.blocks.entries()].sort(([left], [right]) => left - right)) {
      if (block.type === 'text' && block.text) content.push({ type: 'text', text: block.text })
      else if (block.type === 'thinking' && block.signature) {
        content.push({ type: 'thinking', thinking: block.thinking, signature: block.signature })
      } else if (block.type === 'redacted_thinking' && block.data) {
        content.push({ type: 'redacted_thinking', data: block.data })
      } else if (block.type === 'tool_use' && block.id && block.name) {
        content.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: parsedToolInput(block.args, block.initialInput),
        })
      }
    }
    return content
  }

  private assistantMessage(toolCalls: AccumulatedToolCall[], visibleContent: string): ModelMessage | null {
    if (toolCalls.length === 0) return null
    return {
      role: 'assistant',
      content: visibleContent || '',
      anthropic_content: this.preservedContent(),
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
    const tokenUsage: TokenUsage | null = this.inputTokens !== null && this.outputTokens !== null
      ? { inputTokens: this.inputTokens, outputTokens: this.outputTokens }
      : null
    const totalTokens = tokenUsage ? tokenUsageTotal(tokenUsage) : 0
    if (this.streamError) {
      return {
        assistantMessage: null,
        toolCalls: [],
        failed: true,
        totalTokens,
        ...(tokenUsage ? { tokenUsage } : {}),
        content: '',
        finishReason: 'error',
        truncated: false,
        leaked: false,
        hasIncompleteToolCall: false,
        reasoningContent: this.reasoningContent,
        error: this.streamError,
      }
    }
    const toolCalls = this.resolvedToolCalls()
    const visibleContent = this.options.contentPolicy?.({
      content: this.content,
      hasToolCalls: toolCalls.length > 0,
    }) ?? this.content
    if (this.options.deferTextUntilTurnEnd && visibleContent) this.options.emit({ text: visibleContent })
    const incompleteToolCall = toolCalls.some(call => !call.id || !validToolArguments(call.args))
    return {
      assistantMessage: this.assistantMessage(toolCalls, visibleContent),
      toolCalls,
      failed: false,
      totalTokens,
      ...(tokenUsage ? { tokenUsage } : {}),
      content: visibleContent,
      finishReason: this.finishReason,
      truncated: !this.finishReason && !input.sawDone && this.rawContent.length > 0,
      leaked: this.content.length < this.rawContent.length,
      hasIncompleteToolCall: incompleteToolCall,
      reasoningContent: this.reasoningContent,
    }
  }
}
