import { NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import type { Memory } from '@/lib/memory-data'
import { buildSystem } from '@/lib/llm/system'
import { send, done, networkError } from '@/lib/llm/stream'
import { toAnthropic, injectAttachmentsAnthropic, runAnthropicTurn } from '@/lib/llm/anthropic'
import { toOpenAI, chatCompletionsUrl, injectAttachmentsOpenAI, runOpenAITurn } from '@/lib/llm/openai'
import { activeTools, toAnthropicTools, toOpenAITools, execTool, type ToolContext } from '@/lib/tools'

// 最多让模型连续调用工具的轮数（防止无限循环）
const MAX_TOOL_ROUNDS = 6

export async function POST(req: NextRequest) {
  const { protocol, baseUrl, apiKey, model, messages, memories, attachments, webSearch } = await req.json()

  const cleanApiKey = String(apiKey ?? '').trim()
  const cleanBaseUrl = String(baseUrl ?? '').trim()
  const cleanModel = String(model ?? '').trim()

  if (!cleanApiKey) return new Response(JSON.stringify({ error: '请先填写 API Key' }), { status: 400 })
  if (!cleanBaseUrl) return new Response(JSON.stringify({ error: '请填写服务地址' }), { status: 400 })
  if (!cleanModel) return new Response(JSON.stringify({ error: '请填写模型名' }), { status: 400 })
  if (!/^[\x00-\xFF]*$/.test(cleanApiKey)) return new Response(JSON.stringify({ error: 'API Key 包含非法字符' }), { status: 400 })

  // 拿到登录用户身份，用于在工具调用时写入该用户自己的记忆
  let supabase: ToolContext['supabase'] = null
  let userId: string | null = null
  try {
    supabase = await createClient()
    const { data } = await supabase.auth.getUser()
    userId = data.user?.id ?? null
  } catch { supabase = null }

  // 按本次请求上下文筛出可用工具；ctx 供工具执行时写当前用户的数据
  const flags = { loggedIn: !!userId, webSearch: !!webSearch }
  const tools = activeTools(flags)
  const ctx: ToolContext = { supabase, userId }

  const base = cleanBaseUrl.replace(/\/(v1|v1beta)(\/.*)?$/, '').replace(/\/$/, '')
  const SYSTEM = buildSystem(memories as Memory[] | undefined, { webSearch: flags.webSearch })

  const stream = new ReadableStream({
    async start(controller) {
      try {
        if (protocol === 'anthropic') {
          const anthropicTools = toAnthropicTools(tools)
          const msgs = toAnthropic(messages)
          injectAttachmentsAnthropic(msgs, attachments)
          for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
            const { assistantContent, toolUses, failed } = await runAnthropicTurn(base, cleanApiKey, cleanModel, SYSTEM, msgs, anthropicTools, controller)
            if (failed || !toolUses.length) break
            msgs.push({ role: 'assistant', content: assistantContent })
            const results: any[] = []
            for (const tu of toolUses) {
              const { result, event } = await execTool(tools, tu.name, tu.input, ctx)
              if (event) send(controller, event)
              results.push({ type: 'tool_result', tool_use_id: tu.id, content: result })
            }
            msgs.push({ role: 'user', content: results })
          }
        } else {
          const openaiTools = toOpenAITools(tools)
          const url = protocol === 'gemini' ? `${base}/v1beta/openai/chat/completions` : chatCompletionsUrl(cleanBaseUrl)
          const msgs: any[] = [{ role: 'system', content: SYSTEM }, ...toOpenAI(messages)]
          await injectAttachmentsOpenAI(msgs, attachments)
          for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
            const { assistantMessage, toolCalls, failed } = await runOpenAITurn(url, cleanApiKey, cleanModel, msgs, openaiTools, controller)
            if (failed || !toolCalls.length) break
            msgs.push(assistantMessage)
            for (const tc of toolCalls) {
              let input: any = {}
              try { input = JSON.parse(tc.args || '{}') } catch {}
              const { result, event } = await execTool(tools, tc.name, input, ctx)
              if (event) send(controller, event)
              msgs.push({ role: 'tool', tool_call_id: tc.id, content: result })
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
