// 单轮模型请求的纯解析层：发请求、读流、累积正文/思考链/工具调用，返回结构化结果。
// 关键解耦：不认识 SSE controller，只通过注入的 emit 往外推事件 —— 因此可被任意调用方
// （流式 route、单测、非流式场景）复用，也能用 spy 验证。
import { upstreamError } from './stream'
import { makeContentFilter, parseDsmlToolCalls, hasIncompleteDsmlToolCall } from './sanitize'
import type { Emit } from './events'
import { buildProviderRequest, type ProviderAdapterId, type ReasoningEffort } from './provider-adapters'
import { looksLikeCodePreamble, looksLikeCodeSelfTalk } from '@/lib/agent/continuation'
import type { EndpointAuthType } from '@/lib/model-endpoints'
import { safeModelEndpointFetch } from './openai-compatible'
import { MAX_GENERATED_MEDIA_ITEMS, type GeneratedMedia } from '@/lib/generated-media'
import { materializeOpenAICompatibleMedia, type ModelEndpointFetcher } from './media-generation'
import {
  GenericResponseLimitError,
  MAX_GENERIC_ACCUMULATED_TEXT_CHARS,
  MAX_GENERIC_ERROR_RESPONSE_BYTES,
  MAX_GENERIC_SUCCESS_RESPONSE_BYTES,
  declaredResponseBytes,
  mediaFromContentPart,
  readLimitedResponseText,
} from './turn-response'

type ToolCall = { id: string; name: string; args: string }

export type TurnResult = {
  assistantMessage: any
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
  suppressCodeSelfTalk?: boolean
  emitErrors?: boolean
  signal?: AbortSignal
  timeoutMs?: number
  fetcher?: (input: string | URL, init?: RequestInit) => Promise<Response>
  mediaFetcher?: ModelEndpointFetcher
  mediaBudget?: { remaining: number; seen: Set<string> }
  /** Log first upstream event / first text latency */
  logTiming?: boolean
}

// 单轮请求：兼容流式 SSE 与一次性 JSON 两种返回；累积文本、思考链与工具调用。
// emit 用于流式把 thinking/text/error 实时推给前端。
export async function runTurn(
  url: string, apiKey: string, model: string,
  messages: any[], tools: any[], emit: Emit,
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
  })

  const signals = [opts?.signal, AbortSignal.timeout(opts?.timeoutMs ?? 120_000)].filter(Boolean) as AbortSignal[]
  const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals)
  const fetcher = opts?.fetcher ?? (generic ? safeModelEndpointFetch : fetch)
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
    headers: request.headers,
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
    const deltaContent = boundedText(value)
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
    const part = value as Record<string, any>
    if (typeof part.text === 'string') acceptText(part.text)
    else if (typeof part.output_text === 'string') acceptText(part.output_text)
    if (Array.isArray(part.content)) handleContent(part.content)
  }

  function handle(obj: any) {
    if (timingEnabled && firstEventAt === null) {
      firstEventAt = Date.now()
      console.info('[llm/timing] first upstream event', {
        model,
        ms: firstEventAt - startedAt,
        type: obj?.type ?? (obj?.choices ? 'chat.completion.chunk' : typeof obj),
      })
    }
    // Responses API style events (if reverse proxy forwards them)
    if (typeof obj?.type === 'string') {
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
        const d = boundedText(obj.delta ?? obj.text ?? '')
        if (d) {
          if (timingEnabled && firstTextAt === null) {
            firstTextAt = Date.now()
            console.info('[llm/timing] first text', { model, ms: firstTextAt - startedAt })
          }
          acceptText(d)
        }
        return
      }
    }
    if (obj?.usage?.total_tokens) totalTokens = obj.usage.total_tokens
    const choice = obj?.choices?.[0]
    if (!choice) {
      if (Array.isArray(obj?.output)) {
        for (const output of obj.output) handleContent(output)
      }
      return
    }
    if (choice.finish_reason) finishReason = choice.finish_reason
    const delta = choice.delta ?? choice.message ?? {}
    // Grok / OpenAI-compatible reasoning fields (content vs summary)
    const reasoning =
      delta.reasoning_content
      ?? delta.reasoning
      ?? delta.reasoning_text
      ?? delta.reasoning_summary
      ?? delta.reasoning_summary_text
      ?? (typeof delta.reasoning === 'object' && delta.reasoning
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
      for (const [position, tc] of delta.tool_calls.entries()) {
        const idx = tc.index ?? position
        if (!callMap[idx]) callMap[idx] = { id: '', name: '', args: '' }
        if (tc.id) callMap[idx].id = boundedText(tc.id)
        if (tc.function?.name) callMap[idx].name += boundedText(tc.function.name)
        if (tc.function?.arguments) callMap[idx].args += boundedText(tc.function.arguments)
      }
    }
  }

  if (res.headers.get('content-type')?.includes('application/json')) {
    if (generic) {
      handle(JSON.parse(await readLimitedResponseText(res, MAX_GENERIC_SUCCESS_RESPONSE_BYTES)))
    } else {
      handle(await res.json())
    }
  } else {
    const declared = declaredResponseBytes(res)
    if (generic && declared !== null && declared > MAX_GENERIC_SUCCESS_RESPONSE_BYTES) {
      await res.body.cancel().catch(() => undefined)
      throw new GenericResponseLimitError()
    }
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    let responseBytes = 0
    try {
      while (true) {
        const { done: d, value } = await reader.read()
        if (d) break
        if (generic) {
          responseBytes += value.byteLength
          if (responseBytes > MAX_GENERIC_SUCCESS_RESPONSE_BYTES) {
            throw new GenericResponseLimitError()
          }
        }
        buf += dec.decode(value, { stream: true })
        const parts = buf.split(/\r?\n/)
        buf = parts.pop() ?? ''
        for (const part of parts) {
          const line = part.trim()
          if (!line) continue
          if (line === 'data: [DONE]') { sawDone = true; continue }
          const payload = line.startsWith('data:') ? line.slice(5).trim() : line
          if (!payload) continue
          try { handle(JSON.parse(payload)) } catch (error) {
            if (error instanceof GenericResponseLimitError) throw error
          }
        }
      }
      buf += dec.decode()
      const finalLine = buf.trim()
      if (finalLine && finalLine !== 'data: [DONE]') {
        const payload = finalLine.startsWith('data:') ? finalLine.slice(5).trim() : finalLine
        if (payload) {
          try { handle(JSON.parse(payload)) } catch (error) {
            if (error instanceof GenericResponseLimitError) throw error
          }
        }
      } else if (finalLine === 'data: [DONE]') {
        sawDone = true
      }
    } catch (error) {
      if (generic && error instanceof GenericResponseLimitError) {
        await reader.cancel().catch(() => undefined)
      }
      throw error
    } finally {
      reader.releaseLock()
    }
  }

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
  const shouldSuppressContent = !!opts?.suppressCodeSelfTalk && (
    looksLikeCodeSelfTalk(content)
    || (toolCalls.length > 0 && looksLikeCodePreamble(content))
  )
  const visibleContent = shouldSuppressContent ? '' : content
  if (opts?.deferTextUntilTurnEnd && visibleContent) emit({ text: visibleContent })
  let assistantMessage: any = null
  if (toolCalls.length) {
    assistantMessage = {
      role: 'assistant',
      content: visibleContent || '',
      ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
      tool_calls: toolCalls.map(t => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.args || '{}' } })),
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
