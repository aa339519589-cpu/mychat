import { NextRequest } from 'next/server'

const SYSTEM = `你是一个有文学气质的对话伙伴，用温暖、有质感的中文与用户交谈，如同在信笺上写字。
语言自然流露，不堆砌辞藻，也不过于简洁。偶尔引用诗句或比喻，但要恰到好处。`

const enc = new TextEncoder()

function send(controller: ReadableStreamDefaultController, data: object) {
  controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`))
}

function done(controller: ReadableStreamDefaultController) {
  controller.enqueue(enc.encode('data: [DONE]\n\n'))
  controller.close()
}

// 解析 OpenAI / DeepSeek 流
async function streamOpenAI(upstream: Response, controller: ReadableStreamDefaultController) {
  const reader = upstream.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''
  while (true) {
    const { done: d, value } = await reader.read()
    if (d) break
    buf += dec.decode(value, { stream: true })
    const parts = buf.split('\n\n')
    buf = parts.pop() ?? ''
    for (const part of parts) {
      const line = part.trim()
      if (!line || line === 'data: [DONE]') continue
      if (line.startsWith('data: ')) {
        try {
          const j = JSON.parse(line.slice(6))
          const delta = j.choices?.[0]?.delta
          if (delta?.reasoning_content) send(controller, { thinking: delta.reasoning_content })
          if (delta?.content) send(controller, { text: delta.content })
        } catch { /* skip malformed */ }
      }
    }
  }
}

// 解析 Anthropic 流
async function streamAnthropic(upstream: Response, controller: ReadableStreamDefaultController) {
  const reader = upstream.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''
  while (true) {
    const { done: d, value } = await reader.read()
    if (d) break
    buf += dec.decode(value, { stream: true })
    const parts = buf.split('\n\n')
    buf = parts.pop() ?? ''
    for (const part of parts) {
      const lines = part.split('\n')
      const dataLine = lines.find(l => l.startsWith('data: '))
      if (!dataLine) continue
      try {
        const j = JSON.parse(dataLine.slice(6))
        const delta = j.delta
        if (delta?.type === 'text_delta' && delta.text) send(controller, { text: delta.text })
        if (delta?.type === 'thinking_delta' && delta.thinking) send(controller, { thinking: delta.thinking })
      } catch { /* skip */ }
    }
  }
}

export async function POST(req: NextRequest) {
  const { protocol, baseUrl, apiKey, model, messages } = await req.json()

  if (!apiKey) return new Response(JSON.stringify({ error: '请先填写 API Key' }), { status: 400 })
  if (!baseUrl) return new Response(JSON.stringify({ error: '请填写 Base URL' }), { status: 400 })
  if (!/^[\x00-\xFF]*$/.test(apiKey)) return new Response(JSON.stringify({ error: 'API Key 包含非法字符' }), { status: 400 })

  const base = baseUrl.replace(/\/(v1|v1beta)(\/.*)?$/, '').replace(/\/$/, '')

  const stream = new ReadableStream({
    async start(controller) {
      try {
        if (protocol === 'anthropic') {
          const res = await fetch(`${base}/v1/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model, max_tokens: 16000, system: SYSTEM, messages, stream: true, thinking: { type: 'enabled', budget_tokens: 10000 } }),
          })
          if (!res.ok) {
            const txt = await res.text()
            send(controller, { error: `请求失败 (${res.status}): ${txt.slice(0, 200)}` })
          } else {
            await streamAnthropic(res, controller)
          }
        } else if (protocol === 'gemini') {
          const res = await fetch(`${base}/v1beta/openai/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({ model, messages: [{ role: 'system', content: SYSTEM }, ...messages], stream: true }),
          })
          if (!res.ok) {
            const txt = await res.text()
            send(controller, { error: `请求失败 (${res.status}): ${txt.slice(0, 200)}` })
          } else {
            await streamOpenAI(res, controller)
          }
        } else {
          const res = await fetch(`${base}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({ model, messages: [{ role: 'system', content: SYSTEM }, ...messages], stream: true }),
          })
          if (!res.ok) {
            const txt = await res.text()
            send(controller, { error: `请求失败 (${res.status}): ${txt.slice(0, 200)}` })
          } else {
            await streamOpenAI(res, controller)
          }
        }
      } catch (e: any) {
        send(controller, { error: e?.message ?? String(e) })
      } finally {
        done(controller)
      }
    }
  })

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
  })
}
