import { NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import type { Memory } from '@/lib/memory-data'
import { TIER_MAP } from '@/lib/chat-data'
import { buildSystem } from '@/lib/llm/system'
import { send, done, networkError } from '@/lib/llm/stream'
import { toOpenAI, chatCompletionsUrl, injectAttachmentsOpenAI, runOpenAITurn } from '@/lib/llm/openai'
import { activeTools, toOpenAITools, execTool, type ToolContext } from '@/lib/tools'
import { log } from '@/lib/logger'
import { validate } from '@/lib/validation'
import { checkRateLimit } from '@/lib/rate-limit'

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY ?? ''
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'

const MAX_TOOL_ROUNDS = 6
// 长度截断后自动续写的最大轮数（用户要求长回复必须完整，故放宽）
const MAX_CONTINUATIONS = 4

type TurnResult = Awaited<ReturnType<typeof runOpenAITurn>>

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
    if (error || !data) {
      log.warn('checkQuota', 'Failed to fetch profile', { userId, error })
      return { exceeded: false }
    }
    const now = Date.now()
    const start5h = new Date((data.window_5h_start as string) || 0).getTime()
    const start7d = new Date((data.window_7d_start as string) || 0).getTime()
    // 窗口已过期 → 视为已清零
    const t5h = now - start5h >= MS_5H ? 0 : ((data.tokens_5h as number) ?? 0)
    const t7d = now - start7d >= MS_7D ? 0 : ((data.tokens_7d as number) ?? 0)
    const windowExceeded = t5h >= QUOTA_LIMIT_5H || t7d >= QUOTA_LIMIT_7D
    if (!windowExceeded) {
      log.info('checkQuota', 'Quota check passed', { userId, tokens_5h: t5h, tokens_7d: t7d })
      return { exceeded: false }
    }
    // 窗口超限：看余额能不能兜底
    const balance = (data.balance as number) ?? 0
    if (balance > 0) {
      log.info('checkQuota', 'Using balance to cover quota', { userId, balance })
      return { exceeded: false, usingBalance: true }
    }
    // 余额也耗尽
    const which: '5h' | '7d' = t5h >= QUOTA_LIMIT_5H ? '5h' : '7d'
    log.warn('checkQuota', 'Quota exceeded and no balance', { userId, which, tokens_5h: t5h, tokens_7d: t7d })
    return { exceeded: true, which }
  } catch (e) {
    log.error('checkQuota', 'Exception checking quota', e)
    return { exceeded: false }
  }
}

// 写额度：乐观锁 quota_version 防并发抢占，冲突重试。
// 关键修复：①每条失败路径都显式日志（原先 catch{} 静默吞错，是"额度不同步"看不到病因的根源）
//           ②档案行不存在时先 upsert 建行，否则乐观锁 .eq(quota_version,0) 永远匹配 0 行、写不进去
//           ③窗口为 NULL（首条消息）→ start=0 → 判定过期 → 赋当前时间，即"首条消息起算"倒计时
// usingBalance=true 时：时间窗口继续累计（记录真实用量），同时从余额扣除
async function addQuotaUsage(supabase: any, userId: string, rawTokens: number, model: string, isThinking: boolean, usingBalance = false) {
  if (!supabase || !userId || rawTokens <= 0) return
  const weighted = Math.round(rawTokens * tokenMultiplier(model, isThinking))
  log.info('quota', 'Adding quota usage', { userId, rawTokens, weighted, model, isThinking, usingBalance })
  for (let retry = 0; retry < 3; retry++) {
    try {
      const { data, error: selErr } = await supabase
        .from('profiles')
        .select('tokens_5h, window_5h_start, tokens_7d, window_7d_start, quota_version, balance')
        .eq('user_id', userId).maybeSingle()
      if (selErr) {
        log.error('quota', 'Failed to fetch profile (quota table may not exist, see supabase/quota.sql)', selErr)
        return
      }
      // 档案行缺失：先建一行（窗口此刻起算），下一轮重试再累加
      if (!data) {
        const nowIso = new Date().toISOString()
        const { error: insErr } = await supabase.from('profiles').upsert(
          { user_id: userId, tokens_5h: 0, window_5h_start: nowIso, tokens_7d: 0, window_7d_start: nowIso, quota_version: 0 },
          { onConflict: 'user_id' },
        )
        if (insErr) {
          log.error('quota', 'Failed to create profile row', insErr)
          return
        }
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
        updatePayload.balance = Math.max(0, currentBalance - weighted)
      }
      const { data: updated, error: updErr } = await supabase
        .from('profiles')
        .update(updatePayload)
        .eq('user_id', userId)
        .eq('quota_version', oldVersion)
        .select('quota_version')
      if (updErr) {
        log.error('quota', 'Failed to update quota (quota table may not exist, see supabase/quota.sql)', updErr)
        return
      }
      if (updated && updated.length > 0) {
        log.info('quota', 'Quota usage recorded', { userId, tokens_5h: newTokens5h, tokens_7d: newTokens7d })
        return
      }
      // 0 行 = 版本号被并发请求抢占，重试
    } catch (e) {
      log.error('quota', 'Exception in addQuotaUsage', e)
      return
    }
  }
  log.warn('quota', 'Optimistic lock conflict, quota usage not recorded', { userId })
}

// 扫描件 PDF：上传到 DeepSeek Files API，返回 file_id；失败则原样返回（后端会降级为文字提示）
const MAX_PDF_SIZE = 50 * 1024 * 1024 // 50MB
async function uploadScannedPdfs(attachments: any[], apiKey: string, baseUrl: string): Promise<any[]> {
  if (!attachments?.length) return attachments ?? []
  return Promise.all(attachments.map(async (f) => {
    if (!f.isPdf || !f.dataUrl) return f
    try {
      const b64 = typeof f.dataUrl === 'string' ? (f.dataUrl.split(',')[1] ?? '') : ''
      if (!b64) return f
      const buffer = Buffer.from(b64, 'base64')
      if (buffer.length > MAX_PDF_SIZE) {
        log.warn('uploadPdf', `PDF exceeds 50MB limit`, { name: f.name, size: buffer.length })
        return f
      }
      const blob = new Blob([buffer], { type: 'application/pdf' })
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
    } catch (e) {
      log.error('uploadPdf', `Failed to upload PDF`, e)
      return f
    }
  }))
}

export async function POST(req: NextRequest) {
  let body: any = {}
  try {
    body = await req.json()
  } catch (e) {
    log.error('chat', 'Invalid JSON in request body', e)
    return new Response(JSON.stringify({ error: '请求体格式错误' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
  }

  const { tier = '绝句', messages, memories, attachments, webSearch, deepResearch, project } = body

  try {
    validate.array(messages, 'messages', { minLength: 1 })
  } catch (e) {
    log.warn('chat', 'Validation error', e)
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 400, headers: { 'Content-Type': 'application/json' } })
  }

  if (!DEEPSEEK_API_KEY) {
    log.error('chat', 'DEEPSEEK_API_KEY not configured')
    return new Response(JSON.stringify({ error: '服务未配置（DEEPSEEK_API_KEY 未设置）' }), { status: 500 })
  }

  const tierCfg = TIER_MAP[tier as keyof typeof TIER_MAP] ?? TIER_MAP['绝句']
  // 深度研究模式：强制使用最强模型 + 开启思考链
  const model = deepResearch ? 'deepseek-v4-pro' : tierCfg.model
  const thinking = deepResearch ? true : tierCfg.thinking

  let supabase: ToolContext['supabase'] = null
  let userId: string | null = null
  let memoryEnabled = true
  try {
    supabase = await createClient()
    const { data } = await supabase.auth.getUser()
    userId = data.user?.id ?? null
    if (userId) {
      const { data: prof } = await supabase
        .from('profiles')
        .select('memory_enabled')
        .eq('user_id', userId).maybeSingle()
      if (prof) {
        memoryEnabled = prof.memory_enabled !== false
      }
    }
  } catch { supabase = null }

  // 速率限制检查
  if (userId) {
    const { allowed, remaining } = checkRateLimit(userId)
    if (!allowed) {
      log.warn('rateLimit', 'Rate limit exceeded', { userId })
      return new Response(JSON.stringify({ error: '请求过于频繁，请稍后再试' }), { status: 429, headers: { 'Content-Type': 'application/json' } })
    }
    log.info('rateLimit', 'Rate limit check passed', { userId, remaining })
  }

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
  const SYSTEM = buildSystem(effectiveMemories, { webSearch: flags.webSearch, memoryEnabled, project, deepResearch: !!deepResearch })
  const openaiTools = toOpenAITools(tools)

  const stream = new ReadableStream({
    async start(controller) {
      let totalTokensUsed = 0
      let retriedNoTools = false
      const msgs: any[] = [{ role: 'system', content: SYSTEM }, ...toOpenAI(messages)]

      // 长度截断自动续写：紧接上文再请求，前端无感拼接。length 截断不是主病因，这是兜底保险。
      async function continueIfTruncated(turn: TurnResult) {
        let cur = turn
        let cont = 0
        while (cur.finishReason === 'length' && cont < MAX_CONTINUATIONS && !cur.failed) {
          cont++
          msgs.push({ role: 'assistant', content: cur.content })
          msgs.push({ role: 'user', content: '紧接上文继续输出剩余内容，不要重复已经写过的部分，也不要加任何开场白。' })
          log.info('chat', 'Auto-continue after length truncation', { round: cont })
          cur = await runOpenAITurn(url, DEEPSEEK_API_KEY, model, msgs, [], controller, { thinking })
          totalTokensUsed += cur.totalTokens
        }
        if (!cur.failed && cur.finishReason === 'length') {
          send(controller, { text: '\n\n（内容较长，已输出至上限，可回复“继续”获取后续。）' })
        } else if (!cur.failed && cur.truncated) {
          send(controller, { text: '\n\n（回复异常中断，请点击重新生成。）' })
        }
      }

      try {
        const processedAttachments = await uploadScannedPdfs(attachments, DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL)
        await injectAttachmentsOpenAI(msgs, processedAttachments)
        let lastHadToolCalls = false
        let lastTurn: TurnResult | null = null
        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
          let turn = await runOpenAITurn(url, DEEPSEEK_API_KEY, model, msgs, openaiTools, controller, { thinking })
          totalTokensUsed += turn.totalTokens
          // 诊断日志：上线后看 Render 日志即可坐实"中途停止"的真因
          log.info('chat', 'Turn finished', { round, finishReason: turn.finishReason, leaked: turn.leaked, toolCalls: turn.toolCalls.length, contentLen: turn.content.length, truncated: turn.truncated })

          // 工具协议泄漏成正文、又没有结构化工具调用、过滤后没正文 → 该 provider 此刻工具不可靠，关工具重试一轮
          if (turn.leaked && turn.toolCalls.length === 0 && !turn.content.trim() && !retriedNoTools && !turn.failed) {
            retriedNoTools = true
            log.warn('chat', 'Tool markup leaked with no usable content; retrying once without tools')
            turn = await runOpenAITurn(url, DEEPSEEK_API_KEY, model, msgs, [], controller, { thinking })
            totalTokensUsed += turn.totalTokens
          }

          lastTurn = turn
          lastHadToolCalls = turn.toolCalls.length > 0
          if (turn.failed || !lastHadToolCalls) break
          msgs.push(turn.assistantMessage)
          for (const tc of turn.toolCalls) {
            let input: any = {}
            try { input = JSON.parse(tc.args || '{}') } catch {}
            const { result, event } = await execTool(tools, tc.name, input, ctx)
            if (event) send(controller, event)
            msgs.push({ role: 'tool', tool_call_id: tc.id, content: result })
          }
        }
        // 轮次用完但最后一轮还有工具调用 → 补一轮纯文本请求，确保有完整回复
        if (lastHadToolCalls) {
          lastTurn = await runOpenAITurn(url, DEEPSEEK_API_KEY, model, msgs, [], controller, { thinking })
          totalTokensUsed += lastTurn.totalTokens
          log.info('chat', 'Final text turn after tool rounds', { finishReason: lastTurn.finishReason, contentLen: lastTurn.content.length })
        }
        // 长度截断自动续写 / 异常中断提示
        if (lastTurn && !lastTurn.failed) await continueIfTruncated(lastTurn)
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
