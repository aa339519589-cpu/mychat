import { endpointAuthHeaders, normalizeOpenAIBaseUrl, safeModelEndpointFetch } from '@/lib/llm/openai-compatible'
import type { EndpointAuthType } from '@/lib/model-endpoints'

export type LongThinkMessage = { role: 'system' | 'user' | 'assistant'; content: string }
export type LongThinkCompletion = {
  text: string
  reasoning: string
  finishReason: string | null
  usage: { inputTokens: number | null; outputTokens: number | null }
}

type Aggregate = LongThinkCompletion

type CompletionOptions = {
  baseUrl: string
  apiKey: string
  authType: EndpointAuthType
  model: string
  messages: readonly LongThinkMessage[]
  maxTokens: number
  signal: AbortSignal
}

export class LongThinkProviderError extends Error {
  readonly status: number | null
  readonly retryable: boolean

  constructor(message: string, options: { status?: number | null; retryable?: boolean; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'LongThinkProviderError'
    this.status = options.status ?? null
    this.retryable = options.retryable ?? true
  }
}

function completionUrl(baseUrl: string): string {
  return `${normalizeOpenAIBaseUrl(baseUrl)}/chat/completions`
}

function finiteToken(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null
}

function usageFrom(value: unknown): LongThinkCompletion['usage'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { inputTokens: null, outputTokens: null }
  const row = value as Record<string, unknown>
  return {
    inputTokens: finiteToken(row.prompt_tokens ?? row.input_tokens),
    outputTokens: finiteToken(row.completion_tokens ?? row.output_tokens),
  }
}

function textPart(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return ''
    const row = entry as Record<string, unknown>
    if (typeof row.text === 'string') return row.text
    return typeof row.content === 'string' ? row.content : ''
  }).join('')
}

function parseWholeResponse(value: unknown): LongThinkCompletion {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LongThinkProviderError('模型服务返回了无效 JSON', { retryable: true })
  }
  const row = value as Record<string, unknown>
  const choice = Array.isArray(row.choices) ? row.choices[0] : null
  if (!choice || typeof choice !== 'object' || Array.isArray(choice)) {
    throw new LongThinkProviderError('模型服务没有返回 choices', { retryable: true })
  }
  const choiceRow = choice as Record<string, unknown>
  const message = choiceRow.message && typeof choiceRow.message === 'object' && !Array.isArray(choiceRow.message)
    ? choiceRow.message as Record<string, unknown>
    : {}
  return {
    text: textPart(message.content),
    reasoning: textPart(message.reasoning_content ?? message.reasoning),
    finishReason: typeof choiceRow.finish_reason === 'string' ? choiceRow.finish_reason : null,
    usage: usageFrom(row.usage),
  }
}

function appendChoice(entry: unknown, aggregate: Aggregate): void {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return
  const choice = entry as Record<string, unknown>
  const delta = choice.delta && typeof choice.delta === 'object' && !Array.isArray(choice.delta)
    ? choice.delta as Record<string, unknown>
    : {}
  aggregate.text += textPart(delta.content)
  aggregate.reasoning += textPart(delta.reasoning_content ?? delta.reasoning)
  if (typeof choice.finish_reason === 'string') aggregate.finishReason = choice.finish_reason
}

function mergeUsage(value: unknown, aggregate: Aggregate): void {
  const usage = usageFrom(value)
  if (usage.inputTokens !== null) aggregate.usage.inputTokens = usage.inputTokens
  if (usage.outputTokens !== null) aggregate.usage.outputTokens = usage.outputTokens
}

function appendStreamChunk(value: unknown, aggregate: Aggregate): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const row = value as Record<string, unknown>
  const choices = Array.isArray(row.choices) ? row.choices : []
  for (const entry of choices) appendChoice(entry, aggregate)
  mergeUsage(row.usage, aggregate)
}

function consumeSseLine(line: string, aggregate: Aggregate): void {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return
  const data = trimmed.slice(5).trim()
  if (!data || data === '[DONE]') return
  try { appendStreamChunk(JSON.parse(data), aggregate) } catch { /* provider keepalive */ }
}

function drainLines(buffer: string, aggregate: Aggregate): string {
  let remaining = buffer
  let newline = remaining.indexOf('\n')
  while (newline >= 0) {
    consumeSseLine(remaining.slice(0, newline).replace(/\r$/, ''), aggregate)
    remaining = remaining.slice(newline + 1)
    newline = remaining.indexOf('\n')
  }
  return remaining
}

async function parseEventStream(response: Response, signal: AbortSignal): Promise<LongThinkCompletion> {
  if (!response.body) throw new LongThinkProviderError('模型流式响应为空', { retryable: true })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const aggregate: Aggregate = { text: '', reasoning: '', finishReason: null, usage: { inputTokens: null, outputTokens: null } }
  let buffer = ''
  try {
    while (true) {
      if (signal.aborted) throw signal.reason
      const chunk = await reader.read()
      if (chunk.done) break
      buffer = drainLines(buffer + decoder.decode(chunk.value, { stream: true }), aggregate)
    }
    buffer += decoder.decode()
    if (buffer.trim()) consumeSseLine(buffer, aggregate)
  } finally { reader.releaseLock() }
  if (!aggregate.text.trim() && !aggregate.reasoning.trim()) {
    throw new LongThinkProviderError('模型流式响应没有可用内容', { retryable: true })
  }
  return aggregate
}

function requestBody(options: CompletionOptions): string {
  return JSON.stringify({
    model: options.model,
    messages: options.messages,
    max_tokens: options.maxTokens,
    temperature: 0.2,
    stream: true,
    stream_options: { include_usage: true },
  })
}

async function performRequest(options: CompletionOptions, signal: AbortSignal): Promise<Response> {
  try {
    return await safeModelEndpointFetch(completionUrl(options.baseUrl), {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', accept: 'text/event-stream, application/json', ...endpointAuthHeaders(options.apiKey, options.authType) },
      body: requestBody(options),
    })
  } catch (error) {
    if (options.signal.aborted) throw options.signal.reason
    throw new LongThinkProviderError('模型请求连接失败', { retryable: true, cause: error })
  }
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500
}

async function assertSuccess(response: Response): Promise<void> {
  if (response.ok) return
  const status = response.status
  const detail = (await response.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 800)
  const message = detail ? `模型服务 HTTP ${status}: ${detail}` : `模型服务 HTTP ${status}`
  throw new LongThinkProviderError(message, { status, retryable: retryableStatus(status) })
}

async function decodeResponse(response: Response, signal: AbortSignal): Promise<LongThinkCompletion> {
  const type = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (type.includes('text/event-stream')) return parseEventStream(response, signal)
  try { return parseWholeResponse(await response.json()) }
  catch (error) {
    if (error instanceof LongThinkProviderError) throw error
    throw new LongThinkProviderError('模型服务返回的 JSON 无法解析', { retryable: true, cause: error })
  }
}

export async function longThinkCompletion(options: CompletionOptions): Promise<LongThinkCompletion> {
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(30 * 60 * 1000)])
  const response = await performRequest(options, signal)
  await assertSuccess(response)
  return decodeResponse(response, signal)
}
