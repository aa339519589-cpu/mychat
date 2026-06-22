// Anthropic 协议：消息转换、附件注入、单轮流式请求
import type { RawMsg, Attachment } from './types'
import { send, upstreamError } from './stream'

export function toAnthropic(msgs: RawMsg[]) {
  return msgs.map(m => {
    if (!m.images?.length) return { role: m.role, content: m.content }
    return {
      role: m.role,
      content: [
        ...m.images.map(img => {
          const [header, data] = img.split(',')
          const mediaType = (header.match(/data:(.*?);/) ?? [])[1] ?? 'image/jpeg'
          return { type: 'image', source: { type: 'base64', media_type: mediaType, data } }
        }),
        { type: 'text', text: m.content || ' ' },
      ],
    }
  })
}

// 把附件注入最后一条用户消息：前端已提取文字，直接注入 text 字段
export function injectAttachmentsAnthropic(msgs: any[], attachments?: Attachment[]) {
  if (!attachments?.length) return
  const last = msgs[msgs.length - 1]
  if (!last || last.role !== 'user') return
  const extra: any[] = []
  for (const f of attachments) {
    if (f.text) {
      extra.push({ type: 'text', text: `［附件：${f.name}］\n${f.text}` })
    }
  }
  if (!extra.length) return
  last.content = typeof last.content === 'string'
    ? [...extra, { type: 'text', text: last.content || ' ' }]
    : [...extra, ...last.content]
}

// 单轮请求：发一次、流式读取文本与工具调用，返回本轮 assistant 内容与待执行的工具
export async function runAnthropicTurn(
  base: string, apiKey: string, model: string, system: string,
  messages: any[], tools: any[], controller: ReadableStreamDefaultController,
): Promise<{ assistantContent: any[]; toolUses: { id: string; name: string; input: any }[]; failed: boolean }> {
  const body: any = { model, max_tokens: 16000, system, messages, stream: true }
  if (tools.length) body.tools = tools

  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  })
  if (!res.ok || !res.body) {
    send(controller, { error: upstreamError(res.status, await res.text()) })
    return { assistantContent: [], toolUses: [], failed: true }
  }

  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  const blocks: any[] = []

  while (true) {
    const { done: d, value } = await reader.read()
    if (d) break
    buf += dec.decode(value, { stream: true })
    const parts = buf.split('\n\n')
    buf = parts.pop() ?? ''
    for (const part of parts) {
      const dataLine = part.split('\n').find(l => l.startsWith('data: '))
      if (!dataLine) continue
      let j: any
      try { j = JSON.parse(dataLine.slice(6)) } catch { continue }
      if (j.type === 'content_block_start') {
        const cb = j.content_block ?? {}
        blocks[j.index] = { type: cb.type, text: '', name: cb.name, id: cb.id, jsonBuf: '' }
      } else if (j.type === 'content_block_delta') {
        const b = blocks[j.index]
        if (!b) continue
        const delta = j.delta ?? {}
        if (delta.type === 'text_delta') { b.text += delta.text; send(controller, { text: delta.text }) }
        else if (delta.type === 'input_json_delta') { b.jsonBuf += delta.partial_json ?? '' }
      }
    }
  }

  const assistantContent: any[] = []
  const toolUses: { id: string; name: string; input: any }[] = []
  for (const b of blocks) {
    if (!b) continue
    if (b.type === 'text' && b.text) {
      assistantContent.push({ type: 'text', text: b.text })
    } else if (b.type === 'tool_use') {
      let input: any = {}
      try { input = b.jsonBuf ? JSON.parse(b.jsonBuf) : {} } catch {}
      assistantContent.push({ type: 'tool_use', id: b.id, name: b.name, input })
      toolUses.push({ id: b.id, name: b.name, input })
    }
  }
  return { assistantContent, toolUses, failed: false }
}
