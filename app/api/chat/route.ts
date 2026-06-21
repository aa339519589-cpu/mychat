import { NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { extractText, getDocumentProxy } from 'unpdf'

const BASE_SYSTEM = `你叫小克，是一个聊天伙伴，用清楚、自然的中文交谈。说有用的话，不要故意文艺。不要使用 emoji，必要时可以用颜文字。

你拥有长期记忆，可以调用工具来管理对这位用户的记忆：
- 当用户透露了值得长期记住的信息（姓名、身份、职业、喜好、习惯、目标、计划、重要经历或事实）时，调用 remember 保存。
- 当已有的某条记忆需要修正或补充时，调用 update_memory。
- 当某条记忆已经过时、错误，或用户明确要求忘记时，调用 forget。
只在真正有意义时调用，不要为了调用而调用，也不要把闲聊里的临时信息当成长期记忆。如果用户一次性让你记住多件事，必须为每一件分别调用一次 remember，逐条都记下来，绝不能只在回复里口头罗列却没有真正调用工具。调用工具后照常自然地继续回答，不必特意声明你记住了什么。`

type MemoryItem = { id: string; content: string }

function buildSystem(memories?: MemoryItem[]): string {
  if (!memories?.length) return BASE_SYSTEM
  const memBlock = memories.map(m => `<memory id="${m.id}">${m.content}</memory>`).join('\n')
  return `${BASE_SYSTEM}

## 你已经记住的关于这位用户的信息
（需要修改或删除某条时，使用对应的 id）
${memBlock}`
}

// ───────────── 记忆工具定义 ─────────────

const MEMORY_TOOLS_ANTHROPIC = [
  {
    name: 'remember',
    description: '保存一条关于用户的长期记忆。当用户透露值得长期记住的信息时调用。',
    input_schema: {
      type: 'object',
      properties: { content: { type: 'string', description: "要记住的内容，用简洁的第三人称陈述，例如'用户是一名前端工程师'" } },
      required: ['content'],
    },
  },
  {
    name: 'update_memory',
    description: '修正或补充一条已有的记忆，需要提供该记忆的 id。',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string', description: '要更新的记忆 id' }, content: { type: 'string', description: '更新后的完整内容' } },
      required: ['id', 'content'],
    },
  },
  {
    name: 'forget',
    description: '删除一条过时、错误或用户要求忘记的记忆，需要提供该记忆的 id。',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string', description: '要删除的记忆 id' } },
      required: ['id'],
    },
  },
]

const MEMORY_TOOLS_OPENAI = MEMORY_TOOLS_ANTHROPIC.map(t => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.input_schema },
}))

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

type RawMsg = { role: string; content: string; images?: string[] }

function toAnthropic(msgs: RawMsg[]) {
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

function toOpenAI(msgs: RawMsg[]) {
  return msgs.map(m => {
    if (!m.images?.length) return { role: m.role, content: m.content }
    return {
      role: m.role,
      content: [
        ...m.images.map(img => ({ type: 'image_url', image_url: { url: img } })),
        { type: 'text', text: m.content || ' ' },
      ],
    }
  })
}

type Attachment = { name: string; dataUrl: string; isPdf: boolean; text?: string }

// 把附件注入最后一条用户消息：Anthropic 用原生 PDF document（解析质量最佳），文本直接附上
function injectAttachmentsAnthropic(msgs: any[], attachments?: Attachment[]) {
  if (!attachments?.length) return
  const last = msgs[msgs.length - 1]
  if (!last || last.role !== 'user') return
  const extra: any[] = []
  for (const f of attachments) {
    if (f.isPdf && f.dataUrl) {
      const data = f.dataUrl.split(',')[1] ?? ''
      if (data) extra.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data }, title: f.name })
    } else if (f.text) {
      extra.push({ type: 'text', text: `［附件：${f.name}］\n${f.text}` })
    }
  }
  if (!extra.length) return
  last.content = typeof last.content === 'string'
    ? [...extra, { type: 'text', text: last.content || ' ' }]
    : [...extra, ...last.content]
}

// OpenAI/DeepSeek 不支持原生 PDF，后端用 unpdf 提取文字再附上
async function injectAttachmentsOpenAI(msgs: any[], attachments?: Attachment[]) {
  if (!attachments?.length) return
  const last = msgs[msgs.length - 1]
  if (!last || last.role !== 'user') return
  const blocks: string[] = []
  for (const f of attachments) {
    if (f.isPdf && f.dataUrl) {
      try {
        const data = f.dataUrl.split(',')[1] ?? ''
        const buf = new Uint8Array(Buffer.from(data, 'base64'))
        const pdf = await getDocumentProxy(buf)
        const { text } = await extractText(pdf, { mergePages: true })
        const out = Array.isArray(text) ? text.join('\n\n') : text
        blocks.push(`［附件：${f.name}］\n${out || '（未能提取文字，可能是扫描件）'}`)
      } catch {
        blocks.push(`［附件：${f.name}］（解析失败）`)
      }
    } else if (f.text) {
      blocks.push(`［附件：${f.name}］\n${f.text}`)
    }
  }
  if (!blocks.length) return
  const joined = blocks.join('\n\n')
  if (typeof last.content === 'string') {
    last.content = `${last.content}\n\n${joined}`.trim()
  } else if (Array.isArray(last.content)) {
    last.content.push({ type: 'text', text: joined })
  }
}

// ───────────── 工具执行（在用户身份下写 memories 表，受 RLS 隔离） ─────────────

type MemoryResult = { action: 'create' | 'update' | 'delete'; id?: string; content?: string; ok: boolean }

async function execMemoryTool(
  supabase: Awaited<ReturnType<typeof createClient>> | null,
  userId: string | null,
  name: string,
  input: any,
): Promise<MemoryResult> {
  if (!supabase || !userId) return { action: 'create', ok: false }
  try {
    if (name === 'remember') {
      const content = String(input?.content ?? '').trim()
      if (!content) return { action: 'create', ok: false }
      const id = crypto.randomUUID()
      const { error } = await supabase.from('memories').insert({ id, user_id: userId, content })
      return { action: 'create', id, content, ok: !error }
    }
    if (name === 'update_memory') {
      const id = String(input?.id ?? '')
      const content = String(input?.content ?? '').trim()
      const { error } = await supabase.from('memories').update({ content, updated_at: new Date().toISOString() }).eq('id', id)
      return { action: 'update', id, content, ok: !error }
    }
    if (name === 'forget') {
      const id = String(input?.id ?? '')
      const { error } = await supabase.from('memories').delete().eq('id', id)
      return { action: 'delete', id, ok: !error }
    }
  } catch { /* fall through */ }
  return { action: 'create', ok: false }
}

// ───────────── 单轮请求：Anthropic ─────────────

async function runAnthropicTurn(
  base: string, apiKey: string, model: string, system: string,
  messages: any[], useTools: boolean, controller: ReadableStreamDefaultController,
): Promise<{ assistantContent: any[]; toolUses: { id: string; name: string; input: any }[]; failed: boolean }> {
  const body: any = { model, max_tokens: 16000, system, messages, stream: true }
  if (useTools) body.tools = MEMORY_TOOLS_ANTHROPIC

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

// ───────────── 单轮请求：OpenAI / DeepSeek / Gemini 兼容 ─────────────

async function runOpenAITurn(
  url: string, apiKey: string, model: string,
  messages: any[], useTools: boolean, controller: ReadableStreamDefaultController,
): Promise<{ assistantMessage: any; toolCalls: { id: string; name: string; args: string }[]; failed: boolean }> {
  const body: any = { model, messages, stream: true }
  if (useTools) { body.tools = MEMORY_TOOLS_OPENAI; body.tool_choice = 'auto' }

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

export async function POST(req: NextRequest) {
  const { protocol, baseUrl, apiKey, model, messages, memories, attachments } = await req.json()

  const cleanApiKey = String(apiKey ?? '').trim()
  const cleanBaseUrl = String(baseUrl ?? '').trim()
  const cleanModel = String(model ?? '').trim()

  if (!cleanApiKey) return new Response(JSON.stringify({ error: '请先填写 API Key' }), { status: 400 })
  if (!cleanBaseUrl) return new Response(JSON.stringify({ error: '请填写服务地址' }), { status: 400 })
  if (!cleanModel) return new Response(JSON.stringify({ error: '请填写模型名' }), { status: 400 })
  if (!/^[\x00-\xFF]*$/.test(cleanApiKey)) return new Response(JSON.stringify({ error: 'API Key 包含非法字符' }), { status: 400 })

  // 拿到登录用户身份，用于在工具调用时写入该用户自己的记忆
  let supabase: Awaited<ReturnType<typeof createClient>> | null = null
  let userId: string | null = null
  try {
    supabase = await createClient()
    const { data } = await supabase.auth.getUser()
    userId = data.user?.id ?? null
  } catch { supabase = null }
  const useTools = !!userId

  const base = cleanBaseUrl.replace(/\/(v1|v1beta)(\/.*)?$/, '').replace(/\/$/, '')
  const SYSTEM = buildSystem(memories)

  const stream = new ReadableStream({
    async start(controller) {
      try {
        if (protocol === 'anthropic') {
          const msgs = toAnthropic(messages)
          injectAttachmentsAnthropic(msgs, attachments)
          for (let round = 0; round < 6; round++) {
            const { assistantContent, toolUses, failed } = await runAnthropicTurn(base, cleanApiKey, cleanModel, SYSTEM, msgs, useTools, controller)
            if (failed || !toolUses.length) break
            msgs.push({ role: 'assistant', content: assistantContent })
            const results: any[] = []
            for (const tu of toolUses) {
              const r = await execMemoryTool(supabase, userId, tu.name, tu.input)
              send(controller, { memory: r })
              results.push({ type: 'tool_result', tool_use_id: tu.id, content: r.ok ? '操作成功' : '操作失败' })
            }
            msgs.push({ role: 'user', content: results })
          }
        } else {
          const url = protocol === 'gemini' ? `${base}/v1beta/openai/chat/completions` : chatCompletionsUrl(cleanBaseUrl)
          const msgs: any[] = [{ role: 'system', content: SYSTEM }, ...toOpenAI(messages)]
          await injectAttachmentsOpenAI(msgs, attachments)
          for (let round = 0; round < 6; round++) {
            const { assistantMessage, toolCalls, failed } = await runOpenAITurn(url, cleanApiKey, cleanModel, msgs, useTools, controller)
            if (failed || !toolCalls.length) break
            msgs.push(assistantMessage)
            for (const tc of toolCalls) {
              let input: any = {}
              try { input = JSON.parse(tc.args || '{}') } catch {}
              const r = await execMemoryTool(supabase, userId, tc.name, input)
              send(controller, { memory: r })
              msgs.push({ role: 'tool', tool_call_id: tc.id, content: r.ok ? '操作成功' : '操作失败' })
            }
          }
        }
      } catch (error) {
        send(controller, { error: networkError(error) })
      } finally {
        done(controller)
      }
    },
  })

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
  })
}
