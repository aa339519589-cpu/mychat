import { NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import type { Memory } from '@/lib/memory-data'
import { TIER_MAP } from '@/lib/chat-data'
import { buildSystem } from '@/lib/llm/system'
import { send, done, networkError } from '@/lib/llm/stream'
import { toOpenAI, chatCompletionsUrl, injectAttachmentsOpenAI, runOpenAITurn } from '@/lib/llm/openai'
import { activeTools, toOpenAITools, execTool, type ToolContext } from '@/lib/tools'

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY ?? ''
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'

const MAX_TOOL_ROUNDS = 6

export async function POST(req: NextRequest) {
  const { tier = '绝句', messages, memories, attachments, webSearch } = await req.json()

  if (!DEEPSEEK_API_KEY) {
    return new Response(JSON.stringify({ error: '服务未配置（DEEPSEEK_API_KEY 未设置）' }), { status: 500 })
  }

  const tierCfg = TIER_MAP[tier as keyof typeof TIER_MAP] ?? TIER_MAP['绝句']
  const { model, thinking } = tierCfg

  let supabase: ToolContext['supabase'] = null
  let userId: string | null = null
  let memoryEnabled = true
  try {
    supabase = await createClient()
    const { data } = await supabase.auth.getUser()
    userId = data.user?.id ?? null
    if (userId) {
      // 记忆总开关：服务端权威判定（前端伪造也无效）
      const { data: prof } = await supabase.from('profiles').select('memory_enabled').eq('user_id', userId).maybeSingle()
      if (prof) memoryEnabled = prof.memory_enabled !== false
    }
  } catch { supabase = null }

  const flags = { loggedIn: !!userId, webSearch: !!webSearch, memoryEnabled }
  const tools = activeTools(flags)
  const ctx: ToolContext = { supabase, userId }

  // 关闭记忆时：既不挂记忆工具（上面已过滤），也不注入已存的记忆
  const effectiveMemories = memoryEnabled ? (memories as Memory[] | undefined) : undefined
  const url = chatCompletionsUrl(DEEPSEEK_BASE_URL)
  const SYSTEM = buildSystem(effectiveMemories, { webSearch: flags.webSearch, memoryEnabled })
  const openaiTools = toOpenAITools(tools)

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const msgs: any[] = [{ role: 'system', content: SYSTEM }, ...toOpenAI(messages)]
        await injectAttachmentsOpenAI(msgs, attachments)
        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
          const { assistantMessage, toolCalls, failed } = await runOpenAITurn(
            url, DEEPSEEK_API_KEY, model, msgs, openaiTools, controller, { thinking }
          )
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
