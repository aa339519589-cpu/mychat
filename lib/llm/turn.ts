// 单轮模型请求的纯解析层：发请求、读流、累积正文/思考链/工具调用，返回结构化结果。
// 关键解耦：不认识 SSE controller，只通过注入的 emit 往外推事件 —— 因此可被任意调用方
// （流式 route、单测、非流式场景）复用，也能用 spy 验证。
import { upstreamError } from './stream'
import { createHash } from 'node:crypto'
import { makeContentFilter, parseDsmlToolCalls, hasIncompleteDsmlToolCall } from './sanitize'
import type { Emit } from './events'
import { buildProviderRequest, type ProviderAdapterId, type ReasoningEffort } from './provider-adapters'
import type { EndpointAuthType } from '@/lib/model-endpoints'
import { safeModelEndpointFetch } from './openai-compatible'
import { MAX_GENERATED_MEDIA_ITEMS, type GeneratedMedia } from '@/lib/generated-media'
import { materializeOpenAICompatibleMedia, type ModelEndpointFetcher } from './media-generation'
import {
  GenericResponseLimitError,
  MAX_GENERIC_ACCUMULATED_TEXT_CHARS,
  MAX_GENERIC_ERROR_RESPONSE_BYTES,
  mediaFromContentPart,
  readLimitedResponseText,
} from './turn-response'
import { CallerOutputLimitReached, consumeTurnResponse } from './turn-stream'
import { isRecord } from '@/lib/unknown-value'
import type { ModelMessage, ModelToolCall, ModelToolDefinition } from './types'

type ToolCall = { id: string; name: string; args: string }

export type TurnContentPolicy = (input: {
  content: string
  hasToolCalls: boolean
}) => string

export type TurnResult = {
  assistantMessage: ModelMessage | null
  toolCalls: ToolCall[]
  failed: boolean
  totalTokens: number
  content: string
  finishReason: string | null
  truncated: boolean
  leaked: boolean
  hasIncompleteToolCall: boolean
  reasoningContent: string
  error?: string
}

export type RunTurnOptions = {
  thinking?: boolean
  adapter?: ProviderAdapterId
  authType?: EndpointAuthType
  /** Grok / reasoning models via OpenAI-compatible APIs */
  reasoningEffort?: ReasoningEffort | null
  deferTextUntilTurnEnd?: boolean
  /** Optional caller-owned policy for filtering buffered turn text. */
  contentPolicy?: TurnContentPolicy
  emitErrors?: boolean
  signal?: AbortSignal
  timeoutMs?: number
  fetcher?: (input: string | URL, init?: RequestInit) => Promise<Response>
  mediaFetcher?: ModelEndpointFetcher
  mediaBudget?: { remaining: number; seen: Set<string> }
  /** Log first upstream event / first text latency */
  logTiming?: boolean
  /** Sends a provider completion cap and bounds locally accepted visible text. */
  maxOutputTokens?: number
  /** Stable per-job namespace; identical provider bodies reuse one key on retry. */
  idempotencyNamespace?: string
}

// 单轮请求：兼容流式 SSE 与一次性 JSON 两种返回；累积文本、思考链与工具调用。
// emit 用于流式把 thinking/text/error 实时推给前端。
export async function runTurn(
  url: string, apiKey: string, model: string,
  messages: ModelMessage[], tools: ModelToolDefinition[], emit: Emit,
  opts?: RunTurnOptions,
): Promise<TurnResult> {
  const generic = opts?.adapter === 'generic-openai'
  const request = buildProviderRequest(opts?.adapter ?? 'deepseek-openai', {
    model,
    messages,
    tools,
    thinking: !!opts?.thinking,
    apiKey,
    authType: opts?.authType,
    reasoningEffort: opts?.reasoningEffort,
    maxOutputTokens: opts?.maxOutputTokens,
  })

  const signals = [opts?.signal, AbortSignal.timeout(opts?.timeoutMs ?? 120_000)].filter(Boolean) as AbortSignal[]
  const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals)
  const fetcher = opts?.fetcher ?? (generic ? safeModelEndpointFetch : fetch)
  const idempotencyKey = opts?.idempotencyNamespace
    ? createHash('sha256')
      .update(`${opts.idempotencyNamespace}\n${JSON.stringify(request.body)}`)
      .digest('hex')
    : null
  const timingEnabled = opts?.logTiming === true || process.env.DEBUG_LLM_TIMING === '1'
  const startedAt = Date.now()
  let firstEventAt: number | null = null
  let firstTextAt: number | null = null
  if (timingEnabled) {
    console.info('[llm/timing] request started', {
      model,
      adapter: opts?.adapter,
      reasoningEffort: opts?.reasoningEffort ?? null,
      at: startedAt,
      bodyKeys: Object.keys(request.body),
    })
  }

  const res = await fetcher(url, {
    method: 'POST',
    headers: {
      ...request.headers,
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: JSON.stringify(request.body),
    redirect: opts?.adapter === 'generic-openai' ? 'manual' : 'follow',
    signal,
  })
  if (!res.ok || !res.body) {
    const rawError = generic
      ? await readLimitedResponseText(res, MAX_GENERIC_ERROR_RESPONSE_BYTES)
      : await res.text()
    const error = upstreamError(res.status, rawError, '模型服务', [apiKey])
    if (opts?.emitErrors !== false) emit({ error })
    return { assistantMessage: null, toolCalls: [], failed: true, totalTokens: 0, content: '', finishReason: null, truncated: false, leaked: false, hasIncompleteToolCall: false, reasoningContent: '', error }
  }

  let content = ''        // 过滤后、真正发给前端的可见正文
  let rawContent = ''     // 上游 content 原始文本（判断泄漏 + 解析 DSML 文本工具调用）
  let totalTokens = 0
  let finishReason: string | null = null
  let sawDone = false
  let reasoningContent = ''
  let accumulatedTextChars = 0
  let acceptedOutputChars = 0
  const maximumOutputChars = opts?.maxOutputTokens === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(32, Math.min(MAX_GENERIC_ACCUMULATED_TEXT_CHARS, Math.floor(opts.maxOutputTokens) * 8))
  const mediaBudget = opts?.mediaBudget ?? { remaining: MAX_GENERATED_MEDIA_ITEMS, seen: new Set<string>() }
  const pendingRemoteMedia: GeneratedMedia[] = []
  const filter = makeContentFilter()
  const callMap: Record<number, ToolCall> = {}

  function boundedText(value: unknown): string {
    const text = String(value)
    if (generic) {
      accumulatedTextChars += text.length
      if (accumulatedTextChars > MAX_GENERIC_ACCUMULATED_TEXT_CHARS) {
        throw new GenericResponseLimitError()
      }
    }
    return text
  }

  const acceptText = (value: unknown) => {
    if (typeof value !== 'string' || !value) return
    const bounded = boundedText(value)
    const remaining = maximumOutputChars - acceptedOutputChars
    const deltaContent = bounded.slice(0, Math.max(0, remaining))
    const reachedCallerLimit = deltaContent.length < bounded.length
    acceptedOutputChars += deltaContent.length
    rawContent += deltaContent
    const safe = filter.feed(deltaContent)
    if (safe) {
      content += safe
      if (timingEnabled && firstTextAt === null && safe) {
        firstTextAt = Date.now()
        console.info('[llm/timing] first text', { model, ms: firstTextAt - startedAt })
      }
      if (!opts?.deferTextUntilTurnEnd) emit({ text: safe })
    }
    if (reachedCallerLimit) throw new CallerOutputLimitReached()
  }

  const acceptMedia = (value: unknown) => {
    const media = mediaFromContentPart(value)
    if (!media) return false
    const key = `${media.type}:${media.url}`
    if (!mediaBudget.seen.has(key) && mediaBudget.remaining > 0) {
      mediaBudget.seen.add(key)
      mediaBudget.remaining--
      if (/^data:/i.test(media.url)) emit({ media })
      else pendingRemoteMedia.push(media)
    }
    return true
  }

  function handleContent(value: unknown) {
    if (typeof value === 'string') { acceptText(value); return }
    if (Array.isArray(value)) {
      for (const part of value) handleContent(part)
      return
    }
    if (!value || typeof value !== 'object') return
    if (acceptMedia(value)) return
    const part = value as Record<string, unknown>
    if (typeof part.text === 'string') acceptText(part.text)
    else if (typeof part.output_text === 'string') acceptText(part.output_text)
    if (Array.isArray(part.content)) handleContent(part.content)
  }

  function handle(value: unknown) {
    if (!isRecord(value)) return
    const obj = value
    if (timingEnabled && firstEventAt === null) {
      firstEventAt = Date.now()
      console.info('[llm/timing] first upstream event', {
        model,
        ms: firstEventAt - startedAt,
        type: obj.type ?? (obj.choices ? 'chat.completion.chunk' : typeof obj),
      })
    }
    // Responses API style events (if reverse proxy forwards them)
    if (typeof obj.type === 'string') {
      const typ = obj.type as string
      if (
        typ === 'response.reasoning_text.delta'
        || typ === 'response.reasoning_summary_text.delta'
        || typ === 'response.reasoning_summary.delta'
      ) {
        const d = boundedText(obj.delta ?? obj.text ?? '')
        if (d) {
          reasoningContent += d
          emit({ thinking: d })
        }
        return
      }
      if (typ === 'response.output_text.delta') {
        acceptText(obj.delta ?? obj.text ?? '')
        return
      }
    }
    const usage = isRecord(obj.usage) ? obj.usage : null
    if (typeof usage?.total_tokens === 'number') totalTokens = usage.total_tokens
    const choices = Array.isArray(obj.choices) ? obj.choices : []
    const choice = isRecord(choices[0]) ? choices[0] : null
    if (!choice) {
      if (Array.isArray(obj.output)) {
        for (const output of obj.output) handleContent(output)
      }
      return
    }
    if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason
    const deltaValue = choice.delta ?? choice.message
    const delta = isRecord(deltaValue) ? deltaValue : {}
    // Grok / OpenAI-compatible reasoning fields (content vs summary)
    const reasoning =
      delta.reasoning_content
      ?? delta.reasoning
      ?? delta.reasoning_text
      ?? delta.reasoning_summary
      ?? delta.reasoning_summary_text
      ?? (isRecord(delta.reasoning)
        ? (delta.reasoning.content ?? delta.reasoning.text ?? delta.reasoning.summary)
        : null)
    if (reasoning) {
      const reasoningText = boundedText(reasoning)
      if (reasoningText) {
        reasoningContent += reasoningText
        emit({ thinking: reasoningText })
      }
    }
    handleContent(delta.content)
    handleContent(delta.images)
    handleContent(delta.videos)
    if (delta.image_url) acceptMedia({ type: 'image_url', image_url: delta.image_url })
    if (delta.video_url) acceptMedia({ type: 'video_url', video_url: delta.video_url })
    if (Array.isArray(delta.tool_calls)) {
      for (const [position, value] of delta.tool_calls.entries()) {
        if (!isRecord(value)) continue
        const tc = value
        const idx = typeof tc.index === 'number' ? tc.index : position
        if (!callMap[idx]) callMap[idx] = { id: '', name: '', args: '' }
        if (tc.id) callMap[idx].id = boundedText(tc.id)
        const fn = isRecord(tc.function) ? tc.function : null
        if (fn?.name) callMap[idx].name += boundedText(fn.name)
        if (fn?.arguments) callMap[idx].args += boundedText(fn.arguments)
      }
    }
  }

  const consumed = await consumeTurnResponse(res, generic, handle)
  sawDone = consumed.sawDone
  if (consumed.callerLimitReached) finishReason = 'caller_limit'

  for (const media of pendingRemoteMedia) {
    const materialized = await materializeOpenAICompatibleMedia(media, {
      baseUrl: url,
      apiKey,
      authType: opts?.authType ?? 'bearer',
      signal,
      fetcher: opts?.mediaFetcher,
    })
    emit({ media: materialized })
  }

  // 放出过滤器里暂存的尾巴（确保被 hold 的安全文本最终也发出去）
  const tail = filter.flush()
  if (tail) {
    content += tail
    if (!opts?.deferTextUntilTurnEnd) emit({ text: tail })
  }

  let toolCalls = Object.values(callMap).filter(t => t.name)
  // 标准 tool_calls 字段没拿到调用，但模型可能把调用用 DSML 文本写进了 content（deepseek-v4-pro 常见）
  // —— 从原始文本解析出来转成标准调用，让多轮循环照常执行工具、模型不至于中断
  if (toolCalls.length === 0) {
    const parsed = parseDsmlToolCalls(rawContent)
    if (parsed.length) toolCalls = parsed
  }
  const visibleContent = opts?.contentPolicy?.({
    content,
    hasToolCalls: toolCalls.length > 0,
  }) ?? content
  if (opts?.deferTextUntilTurnEnd && visibleContent) emit({ text: visibleContent })
  let assistantMessage: ModelMessage | null = null
  if (toolCalls.length) {
    assistantMessage = {
      role: 'assistant',
      content: visibleContent || '',
      ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
      tool_calls: toolCalls.map<ModelToolCall>(t => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.args || '{}' } })),
    }
  }
  // leaked：上游 content 比过滤后长 = 剥掉了工具协议标记
  const leaked = content.length < rawContent.length
  // truncated：收到了正文、但既无 finish_reason 也无 [DONE] = 上游异常掐断
  const truncated = !finishReason && !sawDone && rawContent.length > 0
  // incomplete：末尾有未闭合的 DSML 工具调用（流被截断，需要 auto-continue）
  const hasIncompleteToolCall = toolCalls.length === 0 && hasIncompleteDsmlToolCall(rawContent)
  return { assistantMessage, toolCalls, failed: false, totalTokens, content: visibleContent, finishReason, truncated, leaked, hasIncompleteToolCall, reasoningContent }
}
