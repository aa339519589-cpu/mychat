import { endpointAuthHeaders, normalizeOpenAIBaseUrl, safeModelEndpointFetch } from '@/lib/llm/openai-compatible'
import type { EndpointAuthType } from '@/lib/model-endpoints'

export type LongThinkMessage = { role: 'system' | 'user' | 'assistant'; content: string }

export type LongThinkCompletion = {
  text: string
  reasoning: string
  finishReason: string | null
  usage: { inputTokens: number | null; outputTokens: number | null }
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
    return typeof row.text === 'string' ? row.text : typeof row.content === 'string' ? row.content : ''
  }).join('')
}

function parseWholeResponse(value: unknown): LongThinkCompletion {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LongThinkProviderError('模型服务返回了无效 JSON', { retryable: true })
  const row = value as Record<string, unknown>
  const choices = Array.isArray(row.choices) ? row.choices : []
  const choice = choices[0]
  if (!choice || typeof choice !== 'object' || Array.isArray(choice)) throw new LongThinkProviderError('模型服务没有返回 choices', { retryable: true })
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

function appendStreamChunk(
  value: unknown,
  aggregate: { text: string; reasoning: string; finishReason: string | null; usage: LongThinkCompletion['usage'] },
): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const row = value as Record<string, unknown>
  const choices = Array.isArray(row.choices) ? row.choices : []
  for (const entry of choices) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const choice = entry as Record<string, unknown>
    const delta = choice.delta && typeof choice.delta === 'object' && !Array.isArray(choice.delta)
      ? choice.delta as Record<string, unknown>
      : {}
    aggregate.text += textPart(delta.content)
    aggregate.reasoning += textPart(delta.reasoning_content ?? delta.reasoning)
    if (typeof choice.finish_reason === 'string') aggregate.finishReason = choice.finish_reason
  }
  const usage = usageFrom(row.usage)
  if (usage.inputTokens !== null) aggregate.usage.inputTokens = usage.inputTokens
  if (usage.outputTokens !== null) aggregate.usage.outputTokens = usage.outputTokens
}

async function parseEventStream(response: Response, signal: AbortSignal): Promise<LongThinkCompletion> {
  if (!response.body) throw new LongThinkProviderError('模型流式响应为空', { retryable: true })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const aggregate: LongThinkCompletion = {
    text: '',
    reasoning: '',
    finishReason: null,
    usage: { inputTokens: null, outputTokens: null },
  }

  const consumeLine = (line: string) => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) return
    const data = trimmed.slice(5).trim()
    if (!data || data === '[DONE]') return
    try { appendStreamChunk(JSON.parse(data), aggregate) } catch { /* ignore malformed keepalive chunks */ }
  }

  try {
    while (true) {
      if (signal.aborted) throw signal.reason
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        consumeLine(buffer.slice(0, newline).replace(/\r$/, ''))
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) consumeLine(buffer)
  } finally {
    reader.releaseLock()
  }
  if (!aggregate.text.trim() && !aggregate.reasoning.trim()) {
    throw new LongThinkProviderError('模型流式响应没有可用内容', { retryable: true })
  }
  return aggregate
}

export async function longThinkCompletion(options: {
  baseUrl: string
  apiKey: string
  authType: EndpointAuthType
  model: string
  messages: readonly LongThinkMessage[]
  maxTokens: number
  signal: AbortSignal
}): Promise<LongThinkCompletion> {
  const timeoutSignal = AbortSignal.timeout(30 * 60 * 1000)
  const signal = AbortSignal.any([options.signal, timeoutSignal])
  let response: Response
  try {
    response = await safeModelEndpointFetch(completionUrl(options.baseUrl), {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream, application/json',
        ...endpointAuthHeaders(options.apiKey, options.authType),
      },
      body: JSON.stringify({
        model: options.model,
        messages: options.messages,
        max_tokens: options.maxTokens,
        temperature: 0.2,
        stream: true,
        stream_options: { include_usage: true },
      }),
    })
  } catch (error) {
    if (options.signal.aborted) throw options.signal.reason
    throw new LongThinkProviderError('模型请求连接失败', { retryable: true, cause: error })
  }

  if (!response.ok) {
    const status = response.status
    const detail = (await response.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 800)
    const retryable = status === 408 || status === 409 || status === 425 || status === 429 || status >= 500
    throw new LongThinkProviderError(detail ? `模型服务 HTTP ${status}: ${detail}` : `模型服务 HTTP ${status}`, { status, retryable })
  }

  const type = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (type.includes('text/event-stream')) return parseEventStream(response, signal)
  try {
    return parseWholeResponse(await response.json())
  } catch (error) {
    if (error instanceof LongThinkProviderError) throw error
    throw new LongThinkProviderError('模型服务返回的 JSON 无法解析', { retryable: true, cause: error })
  }
}
