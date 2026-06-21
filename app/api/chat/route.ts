import { NextRequest } from 'next/server'

const SYSTEM = `你是一个聊天伙伴，用清楚、自然的中文交谈。说有用的话，不要故意文艺。`

const enc = new TextEncoder()

function send(controller: ReadableStreamDefaultController, data: object) {
  controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`))
}

function done(controller: ReadableStreamDefaultController) {
  controller.enqueue(enc.encode('data: [DONE]\n\n'))
  controller.close()
}

function chatCompletionsUrl(baseUrl: string) {
  const base = baseUrl.trim().replace(/\/$/, '')
  if (base.endsWith('/chat/completions')) return base
  if (base.endsWith('/v1')) return `${base}/chat/completions`
  return `${base}/v1/chat/completions`
}

function readErrorMessage(raw: string) {
  try {
    const parsed = JSON.parse(raw)
    return parsed?.error?.message ?? parsed?.message ?? raw
  } catch {
    return raw
  }
}

function upstreamError(status: number, raw: string, source = '模型服务') {
  const message = String(readErrorMessage(raw)).replace(/\s+/g, ' ').trim()
  const modelMismatch = message.match(/supported API model names are (.+?),?\s+but you passed\s+(.+?)(?:[."']|$)/i)

  if (modelMismatch) {
    const supported = modelMismatch[1].replace(/\s+or\s+/gi, ' 或 ')
    const current = modelMismatch[2].trim()
    return `模型名不匹配。该服务支持 ${supported}；当前填写的是 ${current}。请在设置的高级配置里修改模型名。`
  }
  if (status === 401 || status === 403) return `${source}拒绝了 API Key，请检查 Key 或权限。`
  if (status === 429) return `${source}请求过于频繁，或账户余额不足。`

  return `${source}请求失败（${status}）：${message.slice(0, 180) || '未返回原因'}`
}

function networkError(error: unknown, source = '模型服务') {
  const message = error instanceof Error ? error.message : String(error)
  if (message === 'fetch failed') return `无法连接${source}，请检查服务地址。`
  return `${source}请求失败：${message}`
}

function emitOpenAIJson(data: any, controller: ReadableStreamDefaultController) {
  const choice = data?.choices?.[0]
  const delta = choice?.delta
  if (delta?.reasoning_content) send(controller, { thinking: delta.reasoning_content })
  if (delta?.content) send(controller, { text: delta.content })
  if (!delta && choice?.message?.reasoning_content) send(controller, { thinking: choice.message.reasoning_content })
  if (!delta && choice?.message?.content) send(controller, { text: choice.message.content })
}

// 解析 OpenAI / DeepSeek 流
async function streamOpenAI(upstream: Response, controller: ReadableStreamDefaultController) {
  if (upstream.headers.get('content-type')?.includes('application/json')) {
    emitOpenAIJson(await upstream.json(), controller)
    return
  }

  const reader = upstream.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''

  function processLine(raw: string) {
    const line = raw.trim()
    if (!line || line === 'data: [DONE]') return
    const payload = line.startsWith('data:') ? line.slice(5).trim() : line
    if (!payload) return
    try {
      emitOpenAIJson(JSON.parse(payload), controller)
    } catch { /* skip malformed */ }
  }

  while (true) {
    const { done: d, value } = await reader.read()
    if (d) break
    buf += dec.decode(value, { stream: true })
    const parts = buf.split(/\r?\n/)
    buf = parts.pop() ?? ''
    for (const part of parts) processLine(part)
  }
  processLine(buf)
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

async function streamClaudeWeb(sessionKey: string, messages: any[], controller: ReadableStreamDefaultController) {
  const headers: Record<string, string> = {
    'Cookie': `sessionKey=${sessionKey}`,
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Referer': 'https://claude.ai/',
    'Origin': 'https://claude.ai',
  }

  // 获取组织 ID
  const orgRes = await fetch('https://claude.ai/api/organizations', { headers })
  if (!orgRes.ok) {
    send(controller, { error: `sessionKey 无效或已过期，请重新获取 (${orgRes.status})` })
    return
  }
  const orgs = await orgRes.json()
  const orgId = orgs[0]?.uuid
  if (!orgId) {
    send(controller, { error: '无法获取账号组织 ID，请检查登录状态' })
    return
  }

  // 创建对话
  const convId = crypto.randomUUID()
  const convRes = await fetch(`https://claude.ai/api/organizations/${orgId}/chat_conversations`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ uuid: convId, name: '' })
  })
  if (!convRes.ok) {
    send(controller, { error: `创建对话失败 (${convRes.status})` })
    return
  }

  // 发送消息（流式）
  const lastMsg = messages[messages.length - 1]
  const streamRes = await fetch(`https://claude.ai/api/organizations/${orgId}/chat_conversations/${convId}/completion`, {
    method: 'POST',
    headers: { ...headers, 'Accept': 'text/event-stream' },
    body: JSON.stringify({
      prompt: lastMsg.content,
      timezone: 'Asia/Shanghai',
      personalized_styles: null,
      tools: [],
      model: { provider: 'claude_ai', name: 'claude-opus-4-5-20251101' },
    })
  })

  if (!streamRes.ok) {
    const txt = await streamRes.text()
    send(controller, { error: `请求失败 (${streamRes.status}): ${txt.slice(0, 120)}` })
    return
  }

  const reader = streamRes.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''

  while (true) {
    const { done: d, value } = await reader.read()
    if (d) break
    buf += dec.decode(value, { stream: true })
    const parts = buf.split('\n\n')
    buf = parts.pop() ?? ''

    for (const part of parts) {
      for (const line of part.split('\n')) {
        if (!line.startsWith('data: ')) continue
        const payload = line.slice(6).trim()
        if (payload === '[DONE]') return
        try {
          const j = JSON.parse(payload)
          if (j.type === 'content_block_delta' && j.delta?.text) send(controller, { text: j.delta.text })
          else if (j.delta?.type === 'text_delta' && j.delta.text) send(controller, { text: j.delta.text })
          else if (j.completion) send(controller, { text: j.completion })
        } catch { /* skip */ }
      }
    }
  }
}

export async function POST(req: NextRequest) {
  const { protocol, baseUrl, apiKey, model, messages } = await req.json()

  // Claude 网页订阅协议
  if (protocol === 'claude-web') {
    const sessionKey = String(apiKey ?? '').trim()
    if (!sessionKey) return new Response(JSON.stringify({ error: '请填写 sessionKey' }), { status: 400 })
    const stream = new ReadableStream({
      async start(controller) {
        try { await streamClaudeWeb(sessionKey, messages, controller) }
        catch (error) { send(controller, { error: networkError(error) }) }
        finally { done(controller) }
      }
    })
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } })
  }

  const cleanApiKey = String(apiKey ?? '').trim()
  const cleanBaseUrl = String(baseUrl ?? '').trim()
  const cleanModel = String(model ?? '').trim()

  if (!cleanApiKey) return new Response(JSON.stringify({ error: '请先填写 API Key' }), { status: 400 })
  if (!cleanBaseUrl) return new Response(JSON.stringify({ error: '请填写服务地址' }), { status: 400 })
  if (!cleanModel) return new Response(JSON.stringify({ error: '请填写模型名' }), { status: 400 })
  if (!/^[\x00-\xFF]*$/.test(cleanApiKey)) return new Response(JSON.stringify({ error: 'API Key 包含非法字符' }), { status: 400 })

  const base = cleanBaseUrl.replace(/\/(v1|v1beta)(\/.*)?$/, '').replace(/\/$/, '')

  const stream = new ReadableStream({
    async start(controller) {
      try {
        if (protocol === 'anthropic') {
          const res = await fetch(`${base}/v1/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': cleanApiKey, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model: cleanModel, max_tokens: 16000, system: SYSTEM, messages, stream: true, thinking: { type: 'enabled', budget_tokens: 10000 } }),
          })
          if (!res.ok) {
            const txt = await res.text()
            send(controller, { error: upstreamError(res.status, txt) })
          } else {
            await streamAnthropic(res, controller)
          }
        } else if (protocol === 'gemini') {
          const res = await fetch(`${base}/v1beta/openai/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cleanApiKey}` },
            body: JSON.stringify({ model: cleanModel, messages: [{ role: 'system', content: SYSTEM }, ...messages], stream: true }),
          })
          if (!res.ok) {
            const txt = await res.text()
            send(controller, { error: upstreamError(res.status, txt) })
          } else {
            await streamOpenAI(res, controller)
          }
        } else {
          const res = await fetch(chatCompletionsUrl(cleanBaseUrl), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cleanApiKey}` },
            body: JSON.stringify({ model: cleanModel, messages: [{ role: 'system', content: SYSTEM }, ...messages], stream: true }),
          })
          if (!res.ok) {
            const txt = await res.text()
            send(controller, { error: upstreamError(res.status, txt) })
          } else {
            await streamOpenAI(res, controller)
          }
        }
      } catch (error) {
        send(controller, { error: networkError(error) })
      } finally {
        done(controller)
      }
    }
  })

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
  })
}
