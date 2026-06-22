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

// Token 倍率：鸿篇/深度研究 3x，正构 1x，绝句 0.8x
// 乐观锁：quota_version 版本号防并发冲突，失败自动重试一次
async function addQuotaUsage(supabase: any, userId: string, rawTokens: number, model: string, isThinking: boolean) {
  if (!supabase || !userId || rawTokens <= 0) return
  for (let retry = 0; retry < 2; retry++) {
    try {
      const multiplier = model.includes('v4-pro') ? 3 : isThinking ? 1 : 0.8
      const weighted = Math.round(rawTokens * multiplier)
      const { data } = await supabase
        .from('profiles')
        .select('tokens_5h, window_5h_start, tokens_7d, window_7d_start, quota_version')
        .eq('user_id', userId).maybeSingle()
      const now = Date.now()
      const nowIso = new Date(now).toISOString()
      const ms5h = 5 * 3600 * 1000
      const ms7d = 7 * 86400 * 1000
      const start5h = new Date((data?.window_5h_start as string) || 0).getTime()
      const start7d = new Date((data?.window_7d_start as string) || 0).getTime()
      const oldVersion = (data?.quota_version as number) ?? 0
      const newTokens5h = (now - start5h >= ms5h ? 0 : ((data?.tokens_5h as number) ?? 0)) + weighted
      const newTokens7d = (now - start7d >= ms7d ? 0 : ((data?.tokens_7d as number) ?? 0)) + weighted
      const newWindow5h = now - start5h >= ms5h ? nowIso : ((data?.window_5h_start as string) ?? nowIso)
      const newWindow7d = now - start7d >= ms7d ? nowIso : ((data?.window_7d_start as string) ?? nowIso)
      // 乐观锁：只有版本号匹配才能更新，否则本轮被并发请求抢占，重试一次
      const { data: updated } = await supabase
        .from('profiles')
        .update({
          tokens_5h: newTokens5h,
          window_5h_start: newWindow5h,
          tokens_7d: newTokens7d,
          window_7d_start: newWindow7d,
          quota_version: oldVersion + 1,
        })
        .eq('user_id', userId)
        .eq('quota_version', oldVersion)
        .select('quota_version')
      if (updated && updated.length > 0) break // 更新成功，退出重试循环
      // 否则版本号冲突，继续重试一次
    } catch { /* best-effort */ }
  }
}

// 扫描件 PDF：上传到 DeepSeek Files API，返回 file_id；失败则原样返回（后端会降级为文字提示）
async function uploadScannedPdfs(attachments: any[], apiKey: string, baseUrl: string): Promise<any[]> {
  if (!attachments?.length) return attachments ?? []
  return Promise.all(attachments.map(async (f) => {
    if (!f.isPdf || !f.dataUrl) return f
    try {
      const b64 = typeof f.dataUrl === 'string' ? (f.dataUrl.split(',')[1] ?? '') : ''
      if (!b64) return f
      const blob = new Blob([Buffer.from(b64, 'base64')], { type: 'application/pdf' })
      const form = new FormData()
      form.append('file', blob, f.name)
      form.append('purpose', 'file-extract')
      const res = await fetch(`${baseUrl}/v1/files`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      })
      if (!res.ok) return f
      const data = await res.json()
      return { ...f, fileId: data.id, dataUrl: '' }
    } catch {
      return f
    }
  }))
}

export async function POST(req: NextRequest) {
  const { tier = '绝句', messages, memories, attachments, webSearch, deepResearch, project } = await req.json()

  if (!DEEPSEEK_API_KEY) {
    return new Response(JSON.stringify({ error: '服务未配置（DEEPSEEK_API_KEY 未设置）' }), { status: 500 })
  }

  const tierCfg = TIER_MAP[tier as keyof typeof TIER_MAP] ?? TIER_MAP['绝句']
  // 深度研究模式：强制使用最强模型 + 开启思考链
  const model = deepResearch ? 'deepseek-v4-pro' : tierCfg.model
  const thinking = deepResearch ? true : tierCfg.thinking

  let supabase: ToolContext['supabase'] = null
  let userId: string | null = null
  let memoryEnabled = true
  let customSystemPrompt = ''
  try {
    supabase = await createClient()
    const { data } = await supabase.auth.getUser()
    userId = data.user?.id ?? null
    if (userId) {
      const { data: prof } = await supabase
        .from('profiles')
        .select('memory_enabled, custom_system_prompt')
        .eq('user_id', userId).maybeSingle()
      if (prof) {
        memoryEnabled = prof.memory_enabled !== false
        customSystemPrompt = ((prof.custom_system_prompt as string) ?? '').trim()
      }
    }
  } catch { supabase = null }

  const flags = { loggedIn: !!userId, webSearch: !!webSearch, memoryEnabled }
  const tools = activeTools(flags)
  const ctx: ToolContext = { supabase, userId }

  // 关闭记忆时：既不挂记忆工具（上面已过滤），也不注入已存的记忆
  const effectiveMemories = memoryEnabled ? (memories as Memory[] | undefined) : undefined
  const url = chatCompletionsUrl(DEEPSEEK_BASE_URL)
  const SYSTEM = buildSystem(effectiveMemories, { webSearch: flags.webSearch, memoryEnabled, project, deepResearch: !!deepResearch, customSystemPrompt: customSystemPrompt || undefined })
  const openaiTools = toOpenAITools(tools)

  const stream = new ReadableStream({
    async start(controller) {
      let totalTokensUsed = 0
      try {
        const msgs: any[] = [{ role: 'system', content: SYSTEM }, ...toOpenAI(messages)]
        const processedAttachments = await uploadScannedPdfs(attachments, DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL)
        await injectAttachmentsOpenAI(msgs, processedAttachments)
        let lastHadToolCalls = false
        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
          const { assistantMessage, toolCalls, failed, totalTokens } = await runOpenAITurn(
            url, DEEPSEEK_API_KEY, model, msgs, openaiTools, controller, { thinking }
          )
          totalTokensUsed += totalTokens
          lastHadToolCalls = toolCalls.length > 0
          if (failed || !lastHadToolCalls) break
          msgs.push(assistantMessage)
          for (const tc of toolCalls) {
            let input: any = {}
            try { input = JSON.parse(tc.args || '{}') } catch {}
            const { result, event } = await execTool(tools, tc.name, input, ctx)
            if (event) send(controller, event)
            msgs.push({ role: 'tool', tool_call_id: tc.id, content: result })
          }
        }
        // 轮次用完但最后一轮还有工具调用 → 补一轮纯文本请求，确保有完整回复
        if (lastHadToolCalls) {
          const { totalTokens: ft } = await runOpenAITurn(url, DEEPSEEK_API_KEY, model, msgs, [], controller, { thinking })
          totalTokensUsed += ft
        }
      } catch (error) {
        send(controller, { error: networkError(error) })
      } finally {
        // 写额度必须在关闭响应前完成，确保同步性
        if (userId && supabase) {
          await addQuotaUsage(supabase, userId, totalTokensUsed, model, thinking)
        }
        done(controller)
      }
    },
  })

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
  })
}
