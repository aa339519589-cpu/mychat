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

// 加权额度上限（与 QuotaScreen 展示的 max 一致）
const QUOTA_LIMIT_5H = 500_000
const QUOTA_LIMIT_7D = 10_000_000
const MS_5H = 5 * 3600 * 1000
const MS_7D = 7 * 86400 * 1000

// 倍率：鸿篇/深度研究(v4-pro) 3x，正构(思考) 1x，绝句 0.8x
function tokenMultiplier(model: string, isThinking: boolean) {
  return model.includes('v4-pro') ? 3 : isThinking ? 1 : 0.8
}

// 发送前置检查：当前窗口内加权用量是否已达上限。
// fail-open：任何读取异常（含额度列尚未建表）都放行，绝不因后台问题错杀正常发送。
async function checkQuotaExceeded(supabase: any, userId: string): Promise<{ exceeded: boolean; which?: '5h' | '7d'; usingBalance?: boolean }> {
  if (!supabase || !userId) return { exceeded: false }
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('tokens_5h, window_5h_start, tokens_7d, window_7d_start, balance')
      .eq('user_id', userId).maybeSingle()
    if (error || !data) return { exceeded: false }
    const now = Date.now()
    const start5h = new Date((data.window_5h_start as string) || 0).getTime()
    const start7d = new Date((data.window_7d_start as string) || 0).getTime()
    // 窗口已过期 → 视为已清零
    const t5h = now - start5h >= MS_5H ? 0 : ((data.tokens_5h as number) ?? 0)
    const t7d = now - start7d >= MS_7D ? 0 : ((data.tokens_7d as number) ?? 0)
    const windowExceeded = t5h >= QUOTA_LIMIT_5H || t7d >= QUOTA_LIMIT_7D
    if (!windowExceeded) return { exceeded: false }
    // 窗口超限：看余额能不能兜底
    const balance = (data.balance as number) ?? 0
    if (balance > 0) return { exceeded: false, usingBalance: true }
    // 余额也耗尽
    const which: '5h' | '7d' = t5h >= QUOTA_LIMIT_5H ? '5h' : '7d'
    return { exceeded: true, which }
  } catch {
    return { exceeded: false }
  }
}

// 写额度：乐观锁 quota_version 防并发抢占，冲突重试。
// 关键修复：①每条失败路径都显式 console.error（原先 catch{} 静默吞错，是"额度不同步"看不到病因的根源）
//           ②档案行不存在时先 upsert 建行，否则乐观锁 .eq(quota_version,0) 永远匹配 0 行、写不进去
//           ③窗口为 NULL（首条消息）→ start=0 → 判定过期 → 赋当前时间，即"首条消息起算"倒计时
// usingBalance=true 时：时间窗口继续累计（记录真实用量），同时从余额扣除
async function addQuotaUsage(supabase: any, userId: string, rawTokens: number, model: string, isThinking: boolean, usingBalance = false) {
  if (!supabase || !userId || rawTokens <= 0) return
  const weighted = Math.round(rawTokens * tokenMultiplier(model, isThinking))
  for (let retry = 0; retry < 3; retry++) {
    try {
      const { data, error: selErr } = await supabase
        .from('profiles')
        .select('tokens_5h, window_5h_start, tokens_7d, window_7d_start, quota_version, balance')
        .eq('user_id', userId).maybeSingle()
      if (selErr) {
        console.error('[quota] 读取档案失败（额度列可能尚未建表，见 supabase/quota.sql）:', selErr.message)
        return
      }
      // 档案行缺失：先建一行（窗口此刻起算），下一轮重试再累加
      if (!data) {
        const nowIso = new Date().toISOString()
        const { error: insErr } = await supabase.from('profiles').upsert(
          { user_id: userId, tokens_5h: 0, window_5h_start: nowIso, tokens_7d: 0, window_7d_start: nowIso, quota_version: 0 },
          { onConflict: 'user_id' },
        )
        if (insErr) { console.error('[quota] 创建档案行失败:', insErr.message); return }
        continue
      }
      const now = Date.now()
      const nowIso = new Date(now).toISOString()
      const start5h = new Date((data.window_5h_start as string) || 0).getTime()
      const start7d = new Date((data.window_7d_start as string) || 0).getTime()
      const oldVersion = (data.quota_version as number) ?? 0
      const newTokens5h = (now - start5h >= MS_5H ? 0 : ((data.tokens_5h as number) ?? 0)) + weighted
      const newTokens7d = (now - start7d >= MS_7D ? 0 : ((data.tokens_7d as number) ?? 0)) + weighted
      const newWindow5h = now - start5h >= MS_5H ? nowIso : ((data.window_5h_start as string) ?? nowIso)
      const newWindow7d = now - start7d >= MS_7D ? nowIso : ((data.window_7d_start as string) ?? nowIso)
      const updatePayload: Record<string, unknown> = {
        tokens_5h: newTokens5h,
        window_5h_start: newWindow5h,
        tokens_7d: newTokens7d,
        window_7d_start: newWindow7d,
        quota_version: oldVersion + 1,
      }
      if (usingBalance) {
        const currentBalance = (data.balance as number) ?? 0
        // 允许轻微为负（pre-check 到扣款之间的时间差），下次 pre-check 会检测到 ≤0 并拦截
        updatePayload.balance = Math.max(0, currentBalance - weighted)
      }
      const { data: updated, error: updErr } = await supabase
        .from('profiles')
        .update(updatePayload)
        .eq('user_id', userId)
        .eq('quota_version', oldVersion)
        .select('quota_version')
      if (updErr) {
        console.error('[quota] 写额度失败（额度列可能尚未建表，见 supabase/quota.sql）:', updErr.message)
        return
      }
      if (updated && updated.length > 0) return // 成功
      // 0 行 = 版本号被并发请求抢占，重试
    } catch (e) {
      console.error('[quota] addQuotaUsage 异常:', e)
      return
    }
  }
  console.warn('[quota] 乐观锁连续冲突，本次用量未计入')
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

  // 额度达限拦截：时间窗口超限时先看余额；余额也耗尽才返回 429
  let usingBalance = false
  if (userId && supabase) {
    const q = await checkQuotaExceeded(supabase, userId)
    if (q.exceeded) {
      const window = q.which === '5h' ? '5 小时' : '7 天'
      const msg = `${window}用量已达上限，余额也已耗尽，暂时无法发送消息。可在「设置 · 使用额度」充值，或等待窗口重置后继续。`
      return new Response(JSON.stringify({ error: msg }), { status: 429, headers: { 'Content-Type': 'application/json' } })
    }
    usingBalance = q.usingBalance ?? false
  }

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
          await addQuotaUsage(supabase, userId, totalTokensUsed, model, thinking, usingBalance)
        }
        done(controller)
      }
    },
  })

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
  })
}
