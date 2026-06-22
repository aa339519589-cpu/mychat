// OpenAI / DeepSeek / Gemini 兼容协议：消息转换、附件注入、单轮流式请求
import type { RawMsg, Attachment } from './types'
import { send, upstreamError } from './stream'

export function toOpenAI(msgs: RawMsg[]) {
  return msgs.map(m => {
    // 给用户消息附加 ISO 8601 时间戳（系统元数据，供模型做时间感知，非用户输入）
    const content = m.role === 'user' && m.ts ? `${m.content}\n\n[发送时间：${m.ts}]` : m.content
    if (!m.images?.length) return { role: m.role, content }
    return {
      role: m.role,
      content: [
        ...m.images.map(img => ({ type: 'image_url', image_url: { url: img } })),
        { type: 'text', text: content || ' ' },
      ],
    }
  })
}

export function chatCompletionsUrl(baseUrl: string) {
  const base = baseUrl.trim().replace(/\/$/, '')
  if (base.endsWith('/chat/completions')) return base
  if (base.endsWith('/v1')) return `${base}/chat/completions`
  return `${base}/v1/chat/completions`
}

// 注入附件：文本附件直接拼文字；扫描件 PDF（已由路由上传至 Files API）用 file 类型引用
export async function injectAttachmentsOpenAI(msgs: any[], attachments?: Attachment[]) {
  if (!attachments?.length) return
  const last = msgs[msgs.length - 1]
  if (!last || last.role !== 'user') return

  const textParts: string[] = []
  const fileRefs: { type: 'file'; file: { file_id: string } }[] = []

  for (const f of attachments) {
    if (f.fileId) {
      textParts.push(`［附件：${f.name}］`)
      fileRefs.push({ type: 'file', file: { file_id: f.fileId } })
    } else if (f.text) {
      textParts.push(`［附件：${f.name}］\n${f.text}`)
    }
  }

  if (!textParts.length && !fileRefs.length) return

  const textBlock = textParts.join('\n\n')

  if (fileRefs.length) {
    // 有文件引用时，content 必须是数组格式
    const existingText = typeof last.content === 'string' ? last.content
      : (Array.isArray(last.content) ? last.content.find((b: any) => b.type === 'text')?.text ?? '' : '')
    last.content = [
      { type: 'text', text: [existingText, textBlock].filter(Boolean).join('\n\n').trim() || ' ' },
      ...fileRefs,
    ]
  } else if (textBlock) {
    if (typeof last.content === 'string') {
      last.content = `${last.content}\n\n${textBlock}`.trim()
    } else if (Array.isArray(last.content)) {
      last.content.push({ type: 'text', text: textBlock })
    }
  }
}

// 单轮请求：兼容流式 SSE 与一次性 JSON 两种返回；累积文本、思考链与工具调用
export async function runOpenAITurn(
  url: string, apiKey: string, model: string,
  messages: any[], tools: any[], controller: ReadableStreamDefaultController,
  opts?: { thinking?: boolean },
): Promise<{ assistantMessage: any; toolCalls: { id: string; name: string; args: string }[]; failed: boolean }> {
  const body: any = { model, messages, stream: true }
  body.thinking = { type: opts?.thinking ? "enabled" : "disabled" }
  if (tools.length) { body.tools = tools; body.tool_choice = 'auto' }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  })
  if (!res.ok || !res.body) {
    send(controller, { error: upstreamError(res.status, await res.text()) })
    return { assistantMessage: null, toolCalls: [], failed: true }
  }

  let content = ''
  const callMap: Record<number, { id: string; name: string; args: string }> = {}

  function handle(obj: any) {
    const choice = obj?.choices?.[0]
    if (!choice) return
    const delta = choice.delta ?? choice.message ?? {}
    if (delta.reasoning_content) send(controller, { thinking: delta.reasoning_content })
    if (delta.content) { content += delta.content; send(controller, { text: delta.content }) }
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
        if (!line || line === 'data: [DONE]') continue
        const payload = line.startsWith('data:') ? line.slice(5).trim() : line
        if (!payload) continue
        try { handle(JSON.parse(payload)) } catch {}
      }
    }
  }

  const toolCalls = Object.values(callMap).filter(t => t.name)
  let assistantMessage: any = null
  if (toolCalls.length) {
    assistantMessage = {
      role: 'assistant',
      content: content || null,
      tool_calls: toolCalls.map(t => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.args || '{}' } })),
    }
  }
  return { assistantMessage, toolCalls, failed: false }
}
