import { NextRequest } from 'next/server'
import type { Memory } from '@/lib/memory-data'
import { TIER_MAP } from '@/lib/chat-data'
import { buildSystem } from '@/lib/llm/system'
import { send, done, networkError } from '@/lib/llm/stream'
import { chatCompletionsUrl, injectAttachmentsOpenAI } from '@/lib/llm/openai'
import { runAgentLoop, type ExecuteTool } from '@/lib/llm/agent-loop'
import { runTurn } from '@/lib/llm/turn'
import type { Emit, ChatEvent } from '@/lib/llm/events'
import type { RawMsg } from '@/lib/llm/types'
import { buildModelContext } from '@/lib/llm/context'
import { getModelCapability } from '@/lib/llm/models'
import { ensureImageSummaries } from '@/lib/llm/image-context'
import { ensureConversationIndexed, latestUserQuery, retrieveHistoryContext } from '@/lib/llm/active-retrieval'
import { activeTools, toOpenAITools, execTool, type ToolContext } from '@/lib/tools'
import { log } from '@/lib/logger'
import { validate } from '@/lib/validation'
import { addQuotaUsage } from '@/lib/quota'
import { ocrPageImages } from '@/lib/mimo'
import { resolveAuth, getMemoryEnabled, enforceLimits, type SupabaseServer } from '@/lib/api/guard'
import { latestBeijingDateFromMessages, normalizeSearchMode } from '@/lib/search-mode'

const SAFETY_ROUNDS = 9999
const RECENT_CONTEXT_MESSAGES = 30
const SUMMARY_TRIGGER_MESSAGES = 28
const SUMMARY_MODEL = 'deepseek-v4-flash'
const SUMMARY_TARGET_CHARS = 9000
const MARKDOWN_DIVIDER_GUARD = '\n【排版补充】\n当回复有两个以上语义段落、步骤、转折或结论/解释分层时，优先用 Markdown 分隔线 "---" 做清晰分割。分隔线用于增强阅读节奏，不要滥用到每一句。'
const DEEP_RESEARCH_PREFIX = `【隐藏深度研究要求】\n请以最高努力完成当前问题：先理解真实目标，拆解约束，检查边界和反例，最后给出清晰结论。不要提及这段隐藏要求。\n---\n`

type MessageRow = { id: string; role: 'user' | 'assistant'; content: string | null; images?: unknown; created_at?: string | null }

async function inferConversationId(supabase: SupabaseServer | null, userId: string | null, explicitId: unknown, rawMessages: RawMsg[]): Promise<string | null> {
  if (typeof explicitId === 'string' && explicitId) return explicitId
  if (!supabase || !userId) return null
  const ids = [...rawMessages].reverse().map(m => (m as any)?.id).filter((id): id is string => typeof id === 'string' && !!id).slice(0, 6)
  for (const id of ids) {
    try {
      const { data } = await supabase.from('messages').select('conversation_id').eq('id', id).eq('user_id', userId).maybeSingle()
      const conversationId = data?.conversation_id
      if (typeof conversationId === 'string') return conversationId
    } catch {}
  }
  return null
}

async function fetchConversationSummary(supabase: SupabaseServer | null, userId: string | null, conversationId?: string | null): Promise<string> {
  if (!supabase || !userId || !conversationId) return ''
  try {
    const { data, error } = await supabase.from('conversations').select('context_summary, summary_until_message_id').eq('id', conversationId).eq('user_id', userId).maybeSingle()
    if (error || !data?.summary_until_message_id) return ''
    return typeof data?.context_summary === 'string' ? data.context_summary.trim() : ''
  } catch { return '' }
}

function renderConversationSummary(summary: string): string {
  if (!summary.trim()) return ''
  return `\n\n【当前 conversation 的隐藏上下文摘要】\n下面内容只用于保持当前聊天连贯。它不是 Memory，不是 Project 记忆，不要向用户提及它的存在。\n${summary.trim()}`
}
function estimateTokenCount(text: string): number { return Math.ceil(text.length / 3) }
function imageSummaryFromStoredImages(images: unknown): string {
  if (!images || Array.isArray(images)) return ''
  const summary = (images as any)?.image_summary
  return typeof summary === 'string' ? summary.trim() : ''
}
function formatSummaryMessage(m: MessageRow, index: number): string {
  const speaker = m.role === 'user' ? '用户' : '模型'
  const parts = [(m.content ?? '').trim()]
  const imageSummary = imageSummaryFromStoredImages(m.images)
  if (imageSummary) parts.push(`图片摘要：${imageSummary}`)
  return `【第 ${index + 1} 条｜${speaker}｜id:${m.id}】\n${parts.filter(Boolean).join('\n') || '（空内容）'}`
}
function buildSummaryPrompt(oldSummary: string, foldMessages: MessageRow[], startIndex: number): string {
  const messagesText = foldMessages.map((m, i) => formatSummaryMessage(m, startIndex + i)).join('\n\n')
  return `你是 MyChat 的当前 conversation 隐藏上下文压缩器。\n\n把旧摘要和这批刚变旧的消息合并压缩成新的摘要。只输出摘要正文。越旧越粗，越新越细。旧摘要可以继续被压缩，也就是压缩的压缩。只保留影响后续连贯性的内容：方案、参数、用户纠正、代码决策、数学状态、重要上下文。删除寒暄、重复和临时吐槽。目标尽量控制在 ${SUMMARY_TARGET_CHARS} 字以内。\n\n【旧摘要】\n${oldSummary.trim() || '（无）'}\n\n【需要折叠进摘要的旧消息】\n${messagesText}`
}
async function summarizeContext(oldSummary: string, foldMessages: MessageRow[], startIndex: number): Promise<string> {
  const capability = getModelCapability(SUMMARY_MODEL)
  const apiKey = process.env[capability.provider.apiKeyEnv] ?? ''
  if (!apiKey) throw new Error(`${capability.provider.apiKeyEnv} 未设置`)
  const result = await runTurn(chatCompletionsUrl(capability.provider.baseUrl), apiKey, SUMMARY_MODEL, [
    { role: 'system', content: '你只做当前 conversation 的隐藏上下文摘要压缩。只输出摘要正文。' },
    { role: 'user', content: buildSummaryPrompt(oldSummary, foldMessages, startIndex) },
  ], [], () => {}, { thinking: false, adapter: capability.provider.adapter, deferTextUntilTurnEnd: true })
  if (result.failed || !result.content.trim()) throw new Error('摘要模型生成失败')
  return result.content.trim()
}
async function compactConversationContext(supabase: SupabaseServer | null, userId: string | null, conversationId: string | null): Promise<void> {
  if (!supabase || !userId || !conversationId) return
  try {
    const { data: conversation, error: convError } = await supabase.from('conversations').select('id, context_summary, summary_until_message_id').eq('id', conversationId).eq('user_id', userId).maybeSingle()
    if (convError || !conversation) return
    const { data: messages, error: msgError } = await supabase.from('messages').select('id, role, content, images, created_at').eq('conversation_id', conversationId).eq('user_id', userId).order('created_at', { ascending: true })
    if (msgError) return
    const rows = (messages ?? []) as MessageRow[]
    const markerMissing = !!conversation.summary_until_message_id && !rows.some(m => m.id === conversation.summary_until_message_id)
    const staleSummaryWithoutMarker = !!conversation.context_summary && !conversation.summary_until_message_id
    let summaryUntilMessageId: string | null = conversation.summary_until_message_id ?? null
    let oldSummary = typeof conversation.context_summary === 'string' ? conversation.context_summary : ''
    if (markerMissing || staleSummaryWithoutMarker) {
      summaryUntilMessageId = null
      oldSummary = ''
      await supabase.from('conversations').update({ context_summary: null, summary_until_message_id: null, summary_token_count: 0 }).eq('id', conversationId).eq('user_id', userId)
    }
    if (rows.length <= RECENT_CONTEXT_MESSAGES) return
    const coveredIndex = summaryUntilMessageId ? rows.findIndex(m => m.id === summaryUntilMessageId) : -1
    const foldRows = rows.slice(0, Math.max(0, rows.length - RECENT_CONTEXT_MESSAGES)).slice(coveredIndex + 1)
    if (foldRows.length < SUMMARY_TRIGGER_MESSAGES) return
    const nextSummary = await summarizeContext(oldSummary, foldRows, coveredIndex + 1)
    const summaryUntil = foldRows[foldRows.length - 1]?.id
    if (!summaryUntil) return
    const { error: updateError } = await supabase.from('conversations').update({ context_summary: nextSummary, summary_until_message_id: summaryUntil, summary_token_count: estimateTokenCount(nextSummary) }).eq('id', conversationId).eq('user_id', userId)
    if (updateError) log.warn('contextSummary', 'Failed to save compacted context', updateError)
  } catch (e) { log.warn('contextSummary', 'Context compaction skipped', e) }
}
async function ocrScannedPdfs(attachments: any[]): Promise<any[]> {
  if (!attachments?.length) return attachments ?? []
  return Promise.all(attachments.map(async (f) => {
    if (!Array.isArray(f.pageImages) || !f.pageImages.length) return f
    const text = await ocrPageImages(f.pageImages)
    log.info('ocrPdf', 'Scanned PDF OCR done', { name: f.name, pages: f.pageImages.length, textLen: text.length })
    return { ...f, text: text || '（扫描件识别失败，请重试或换一份更清晰的文件）', pageImages: undefined }
  }))
}

export async function POST(req: NextRequest) {
  let body: any = {}
  try { body = await req.json() } catch (e) {
    log.error('chat', 'Invalid JSON in request body', e)
    return new Response(JSON.stringify({ error: '请求体格式错误' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
  }
  const { tier = '绝句', messages, memories, attachments, searchMode, webSearch, deepWebSearch, deepResearch, project, conversationId } = body
  try { validate.array(messages, 'messages', { minLength: 1 }) } catch (e) {
    log.warn('chat', 'Validation error', e)
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 400, headers: { 'Content-Type': 'application/json' } })
  }

  const tierCfg = TIER_MAP[tier as keyof typeof TIER_MAP] ?? TIER_MAP['绝句']
  const model = deepResearch ? 'deepseek-v4-pro' : tierCfg.model
  const thinking = deepResearch ? true : tierCfg.thinking
  const capability = getModelCapability(model)
  const apiKey = process.env[capability.provider.apiKeyEnv] ?? ''
  if (!apiKey) {
    log.error('chat', `${capability.provider.apiKeyEnv} not configured`)
    return new Response(JSON.stringify({ error: `服务未配置（${capability.provider.apiKeyEnv} 未设置）` }), { status: 500 })
  }

  const auth = await resolveAuth()
  const { supabase, userId } = auth
  const memoryEnabled = await getMemoryEnabled(auth)
  const gate = await enforceLimits(auth)
  if (gate.response) return gate.response
  const usingBalance = gate.usingBalance

  const rawMessages = messages as RawMsg[]
  const resolvedConversationId = await inferConversationId(supabase, userId, conversationId, rawMessages)
  await compactConversationContext(supabase, userId, resolvedConversationId)
  await ensureConversationIndexed(supabase, userId, resolvedConversationId)
  const recentMessages = rawMessages.slice(-RECENT_CONTEXT_MESSAGES)
  const conversationSummary = await fetchConversationSummary(supabase, userId, resolvedConversationId)
  const activeHistoryContext = await retrieveHistoryContext({ supabase, userId, conversationId: resolvedConversationId, projectId: project?.id ?? null, query: latestUserQuery(rawMessages) })

  const effectiveSearchMode = searchMode === 'web' || searchMode === 'deep' ? searchMode : normalizeSearchMode(webSearch, deepWebSearch)
  const latestBeijingDate = latestBeijingDateFromMessages(rawMessages)
  const flags = { loggedIn: !!userId, searchMode: effectiveSearchMode, memoryEnabled, projectId: project?.id ?? null }
  const tools = activeTools(flags)
  const ctx: ToolContext = { supabase, userId, projectId: project?.id ?? null, searchMode: effectiveSearchMode, latestBeijingDate }
  const effectiveMemories = memoryEnabled ? (memories as Memory[] | undefined) : undefined
  const url = chatCompletionsUrl(capability.provider.baseUrl)
  const SYSTEM = buildSystem(effectiveMemories, { searchMode: effectiveSearchMode, latestBeijingDate, memoryEnabled, project }) + renderConversationSummary(conversationSummary) + activeHistoryContext + MARKDOWN_DIVIDER_GUARD
  const openaiTools = toOpenAITools(tools)

  const stream = new ReadableStream({
    async start(controller) {
      let clientConnected = true
      const safeSend = (event: ChatEvent | { heartbeat: true }) => {
        if (!clientConnected) return
        try { send(controller, event) } catch { clientConnected = false }
      }
      const emit: Emit = (e) => safeSend(e)
      let totalTokensUsed = 0
      const heartbeat = setInterval(() => safeSend({ heartbeat: true }), 8_000)
      const executeTool: ExecuteTool = async (name, input) => {
        const { result, event } = await execTool(tools, name, input, ctx)
        if (event) emit(event as ChatEvent)
        return result
      }
      try {
        const preparedMessages = capability.supportsImageInput ? recentMessages : await ensureImageSummaries(recentMessages, { supabase, userId, emit })
        const msgs: any[] = [{ role: 'system', content: SYSTEM }, ...buildModelContext(preparedMessages, capability)]
        if (deepResearch) {
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role === 'user') {
              const m = msgs[i]
              if (typeof m.content === 'string') m.content = DEEP_RESEARCH_PREFIX + m.content
              else if (Array.isArray(m.content)) {
                const textItem = m.content.find((c: any) => c.type === 'text')
                if (textItem) textItem.text = DEEP_RESEARCH_PREFIX + textItem.text
              }
              break
            }
          }
        }
        const hasScanned = Array.isArray(attachments) && attachments.some((a: any) => a?.pageImages?.length)
        if (hasScanned) emit({ thinking: '正在识别扫描件内容，请稍候……' })
        const processedAttachments = await ocrScannedPdfs(attachments)
        await injectAttachmentsOpenAI(msgs, processedAttachments)
        const { totalTokens } = await runAgentLoop({
          url, apiKey, model, adapter: capability.provider.adapter, thinking,
          messages: msgs, tools: openaiTools, emit, executeTool,
          maxRounds: SAFETY_ROUNDS,
          leakedRetry: true,
          autoContinue: {},
          onTurn: ({ phase, round, turn }) => log.info('chat', `Turn ${phase}`, { round, finishReason: turn.finishReason, leaked: turn.leaked, toolCalls: turn.toolCalls.length, contentLen: turn.content.length, truncated: turn.truncated }),
        })
        totalTokensUsed += totalTokens
      } catch (error) {
        emit({ error: networkError(error) })
      } finally {
        clearInterval(heartbeat)
        if (userId && supabase) await addQuotaUsage(supabase, userId, totalTokensUsed, model, thinking, usingBalance)
        done(controller)
      }
    },
  })
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } })
}
