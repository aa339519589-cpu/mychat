import { NextRequest } from 'next/server'
import { chatCompletionsUrl } from '@/lib/llm/openai'
import { getModelCapability } from '@/lib/llm/models'
import { runTurn } from '@/lib/llm/turn'
import { resolveAuth } from '@/lib/api/guard'
import { log } from '@/lib/logger'

const SUMMARY_MODEL = 'deepseek-v4-flash'
const RECENT_CONTEXT_MESSAGES = 30
const SUMMARY_TRIGGER_MESSAGES = 28
const SUMMARY_TARGET_CHARS = 9000

type MessageRow = {
  id: string
  role: 'user' | 'assistant'
  content: string | null
  images?: unknown
  thinking?: string | null
  created_at?: string | null
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } })
}

function estimateTokenCount(text: string): number {
  // 粗估即可，用来判断摘要膨胀趋势，不做计费依据。
  return Math.ceil(text.length / 3)
}

function imageSummaryFromStoredImages(images: unknown): string {
  if (!images || Array.isArray(images)) return ''
  const summary = (images as any)?.image_summary
  return typeof summary === 'string' ? summary.trim() : ''
}

function formatMessage(m: MessageRow, index: number): string {
  const speaker = m.role === 'user' ? '用户' : '模型'
  const content = (m.content ?? '').trim()
  const imageSummary = imageSummaryFromStoredImages(m.images)
  const parts = [content]
  if (imageSummary) parts.push(`图片摘要：${imageSummary}`)
  return `【第 ${index + 1} 条｜${speaker}｜id:${m.id}】\n${parts.filter(Boolean).join('\n') || '（空内容）'}`
}

function buildSummaryPrompt(oldSummary: string, foldMessages: MessageRow[], startIndex: number): string {
  const messagesText = foldMessages.map((m, i) => formatMessage(m, startIndex + i)).join('\n\n')
  return `你是 MyChat 的“当前 conversation 隐藏上下文压缩器”。

任务：把旧摘要和这批刚刚变旧的消息，合并压缩成一份新的当前对话摘要。

硬规则：
1. 这不是 Memory，不是 Project 记忆，不是用户画像，只属于当前 conversation。
2. 只输出新的摘要正文，不要解释，不要写标题，不要提到“我已压缩”。
3. 越旧越粗，越新越细。
4. 旧摘要可以继续被压缩，也就是“压缩的压缩”。
5. 只保留会影响后续对话连贯性的内容：已定方案、关键参数、用户明确纠正、代码决策、数学推导状态、重要上下文。
6. 删除寒暄、重复、临时吐槽、无长期上下文价值的细节。
7. 用户最近 30 条原文不会交给你压缩，所以不要试图补写最新原文，只处理下面这批旧内容。
8. 目标长度尽量控制在 ${SUMMARY_TARGET_CHARS} 字以内；信息很多时也要优先保主线。

【旧摘要】
${oldSummary.trim() || '（无）'}

【本次需要折叠进摘要的旧消息】
${messagesText}`
}

async function summarize(oldSummary: string, foldMessages: MessageRow[], startIndex: number): Promise<string> {
  const capability = getModelCapability(SUMMARY_MODEL)
  const apiKey = process.env[capability.provider.apiKeyEnv] ?? ''
  if (!apiKey) throw new Error(`${capability.provider.apiKeyEnv} 未设置`)

  const url = chatCompletionsUrl(capability.provider.baseUrl)
  const result = await runTurn(
    url,
    apiKey,
    SUMMARY_MODEL,
    [
      { role: 'system', content: '你只做当前 conversation 的隐藏上下文摘要压缩。只输出摘要正文。' },
      { role: 'user', content: buildSummaryPrompt(oldSummary, foldMessages, startIndex) },
    ],
    [],
    () => {},
    { thinking: false, adapter: capability.provider.adapter, deferTextUntilTurnEnd: true },
  )
  if (result.failed || !result.content.trim()) throw new Error('摘要模型生成失败')
  return result.content.trim()
}

export async function POST(req: NextRequest) {
  let body: any = {}
  try {
    body = await req.json()
  } catch {
    return json({ error: '请求体格式错误' }, 400)
  }

  const conversationId = typeof body.conversationId === 'string' ? body.conversationId : ''
  if (!conversationId) return json({ error: '缺少 conversationId' }, 400)

  const { supabase, userId } = await resolveAuth()
  if (!supabase || !userId) return json({ error: '未登录' }, 401)

  try {
    const { data: conversation, error: convError } = await supabase
      .from('conversations')
      .select('id, context_summary, summary_until_message_id')
      .eq('id', conversationId)
      .eq('user_id', userId)
      .maybeSingle()

    if (convError) return json({ ok: false, error: convError.message }, 500)
    if (!conversation) return json({ error: 'conversation 不存在' }, 404)

    const { data: messages, error: msgError } = await supabase
      .from('messages')
      .select('id, role, content, images, thinking, created_at')
      .eq('conversation_id', conversationId)
      .eq('user_id', userId)
      .order('created_at', { ascending: true })

    if (msgError) return json({ ok: false, error: msgError.message }, 500)
    const rows = (messages ?? []) as MessageRow[]

    const markerMissing = !!conversation.summary_until_message_id && !rows.some(m => m.id === conversation.summary_until_message_id)
    if (markerMissing) {
      await supabase
        .from('conversations')
        .update({ context_summary: null, summary_until_message_id: null, summary_token_count: 0 })
        .eq('id', conversationId)
        .eq('user_id', userId)
      return json({ ok: true, reset: 'stale_summary_marker_missing' })
    }

    if (rows.length <= RECENT_CONTEXT_MESSAGES) {
      return json({ ok: true, skipped: 'not_enough_messages', totalMessages: rows.length })
    }

    const coveredIndex = conversation.summary_until_message_id
      ? rows.findIndex(m => m.id === conversation.summary_until_message_id)
      : -1
    const compressibleEnd = Math.max(0, rows.length - RECENT_CONTEXT_MESSAGES)
    const compressibleRows = rows.slice(0, compressibleEnd)
    const foldRows = compressibleRows.slice(coveredIndex + 1)

    if (foldRows.length < SUMMARY_TRIGGER_MESSAGES) {
      return json({ ok: true, skipped: 'below_trigger', totalMessages: rows.length, foldableMessages: foldRows.length })
    }

    const oldSummary = typeof conversation.context_summary === 'string' ? conversation.context_summary : ''
    const nextSummary = await summarize(oldSummary, foldRows, coveredIndex + 1)
    const summaryUntil = foldRows[foldRows.length - 1]?.id
    if (!summaryUntil) return json({ ok: true, skipped: 'empty_fold' })

    const { error: updateError } = await supabase
      .from('conversations')
      .update({
        context_summary: nextSummary,
        summary_until_message_id: summaryUntil,
        summary_token_count: estimateTokenCount(nextSummary),
      })
      .eq('id', conversationId)
      .eq('user_id', userId)

    if (updateError) return json({ ok: false, error: updateError.message }, 500)

    return json({
      ok: true,
      foldedMessages: foldRows.length,
      summaryUntilMessageId: summaryUntil,
      summaryTokenCount: estimateTokenCount(nextSummary),
    })
  } catch (e: any) {
    log.error('contextSummary', 'Failed to compact conversation context', e)
    return json({ ok: false, error: e?.message ?? String(e) }, 500)
  }
}
