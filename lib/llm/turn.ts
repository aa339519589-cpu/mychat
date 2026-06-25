// 单轮模型请求的纯解析层：发请求、读流、累积正文/思考链/工具调用，返回结构化结果。
// 关键解耦：不认识 SSE controller，只通过注入的 emit 往外推事件 —— 因此可被任意调用方
// （流式 route、单测、非流式场景）复用，也能用 spy 验证。
import { upstreamError } from './stream'
import { makeContentFilter, parseDsmlToolCalls, hasIncompleteDsmlToolCall } from './sanitize'
import type { Emit } from './events'
import { buildProviderRequest, type ProviderAdapterId } from './provider-adapters'
import { looksLikeCodePreamble, looksLikeCodeSelfTalk } from '@/lib/agent/continuation'

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
}

export type RunTurnOptions = {
  thinking?: boolean
  adapter?: ProviderAdapterId
  deferTextUntilTurnEnd?: boolean
  suppressCodeSelfTalk?: boolean
}

// 单轮请求：兼容流式 SSE 与一次性 JSON 两种返回；累积文本、思考链与工具调用。
// emit 用于流式把 thinking/text/error 实时推给前端。
export async function runTurn(
  url: string, apiKey: string, model: string,
  messages: any[], tools: any[], emit: Emit,
  opts?: RunTurnOptions,
): Promise<TurnResult> {
  const request = buildProviderRequest(opts?.adapter ?? 'deepseek-openai', {
    model,
    messages,
    tools,
    thinking: !!opts?.thinking,
    apiKey,
  })

  const res = await fetch(url, {
    method: 'POST',
    headers: request.headers,
    body: JSON.stringify(request.body),
  })
  if (!res.ok || !res.body) {
    emit({ error: upstreamError(res.status, await res.text()) })
    return { assistantMessage: null, toolCalls: [], failed: true, totalTokens: 0, content: '', finishReason: null, truncated: false, leaked: false, hasIncompleteToolCall: false }
  }

  let content = ''        // 过滤后、真正发给前端的可见正文
  let rawContent = ''     // 上游 content 原始文本（判断泄漏 + 解析 DSML 文本工具调用）
  let totalTokens = 0
  let finishReason: string | null = null
  let sawDone = false
  const filter = makeContentFilter()
  const callMap: Record<number, ToolCall> = {}

  function handle(obj: any) {
    if (obj?.usage?.total_tokens) totalTokens = obj.usage.total_tokens
    const choice = obj?.choices?.[0]
    if (!choice) return
    if (choice.finish_reason) finishReason = choice.finish_reason
    const delta = choice.delta ?? choice.message ?? {}
    if (delta.reasoning_content) emit({ thinking: delta.reasoning_content })
    if (delta.content) {
      rawContent += String(delta.content)
      const safe = filter.feed(String(delta.content))
      if (safe) {
        content += safe
        if (!opts?.deferTextUntilTurnEnd) emit({ text: safe })
      }
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0
        if (!callMap[idx]) callMap[idx] = { id: '', name: '', args: '' }
        if (tc.id) callMap[idx].id = tc.id
        if (tc.function?.name) callMap[idx].name += tc.function.name
        if (tc.function?.arguments) callMap[idx].args += tc.function.arguments
      }
    }
  }

  if (res.headers.get('content-type')?.includes('application/json')) {
    handle(await res.json())
  } else {
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    while (true) {
      const { done: d, value } = await reader.read()
      if (d) break
      buf += dec.decode(value, { stream: true })
      const parts = buf.split(/\r?\n/)
      buf = parts.pop() ?? ''
      for (const part of parts) {
        const line = part.trim()
        if (!line) continue
        if (line === 'data: [DONE]') { sawDone = true; continue }
        const payload = line.startsWith('data:') ? line.slice(5).trim() : line
        if (!payload) continue
        try { handle(JSON.parse(payload)) } catch {}
      }
    }
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
      content: visibleContent || null,
      tool_calls: toolCalls.map(t => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.args || '{}' } })),
    }
  }
  // leaked：上游 content 比过滤后长 = 剥掉了工具协议标记
  const leaked = content.length < rawContent.length
  // truncated：收到了正文、但既无 finish_reason 也无 [DONE] = 上游异常掐断
  const truncated = !finishReason && !sawDone && rawContent.length > 0
  // incomplete：末尾有未闭合的 DSML 工具调用（流被截断，需要 auto-continue）
  const hasIncompleteToolCall = toolCalls.length === 0 && hasIncompleteDsmlToolCall(rawContent)
  return { assistantMessage, toolCalls, failed: false, totalTokens, content: visibleContent, finishReason, truncated, leaked, hasIncompleteToolCall }
}
