import { NextRequest } from 'next/server'
import type { Memory } from '@/lib/memory-data'
import { TIER_MAP } from '@/lib/chat-data'
import { buildSystem } from '@/lib/llm/system'
import { send, done, networkError } from '@/lib/llm/stream'
import { chatCompletionsUrl, injectAttachmentsOpenAI } from '@/lib/llm/openai'
import { runAgentLoop, type ExecuteTool } from '@/lib/llm/agent-loop'
import type { Emit, ChatEvent } from '@/lib/llm/events'
import type { RawMsg } from '@/lib/llm/types'
import { buildModelContext } from '@/lib/llm/context'
import { getModelCapability } from '@/lib/llm/models'
import { ensureImageSummaries } from '@/lib/llm/image-context'
import { ensureConversationIndexed, latestUserQuery, retrieveHistoryContext, type HistoryRetrievalMode } from '@/lib/llm/active-retrieval'
import { activeTools, toOpenAITools, execTool, type ToolContext } from '@/lib/tools'
import { log } from '@/lib/logger'
import { validate } from '@/lib/validation'
import { addQuotaUsage } from '@/lib/quota'
import { ocrPageImages } from '@/lib/mimo'
import { resolveAuth, getMemoryEnabled, enforceLimits, type SupabaseServer } from '@/lib/api/guard'
import { latestBeijingDateFromMessages, normalizeSearchMode } from '@/lib/search-mode'

const SAFETY_ROUNDS = 9999
const RECENT_CONTEXT_MESSAGES = 30
const MARKDOWN_DIVIDER_GUARD = '\n【排版补充】\n当回复有两个以上语义段落、步骤、转折或结论/解释分层时，优先用 Markdown 分隔线 "---" 做清晰分割。分隔线用于增强阅读节奏，不要滥用到每一句。'
const DEEP_RESEARCH_PREFIX = `请以最高努力完成当前问题：先理解真实目标，拆解约束，检查边界和反例，最后给出清晰结论。\n---\n`

function historyRetrievalModeForTier(tier: string): HistoryRetrievalMode {
  if (tier === '鸿篇') return 'deep'
  if (tier === '绝句') return 'light'
  return 'balanced'
}

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
  const { tier = '绝句', messages, memories, attachments, searchMode, webSearch, deepWebSearch, deepResearch, project, conversationId, historyRetrieval } = body
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
  const recentMessages = rawMessages.slice(-RECENT_CONTEXT_MESSAGES)
  const historyRetrievalEnabled = historyRetrieval === true
  const conversationSummary = historyRetrievalEnabled
    ? await fetchConversationSummary(supabase, userId, resolvedConversationId)
    : ''
  let activeHistoryContext = ''
  if (historyRetrievalEnabled) {
    await ensureConversationIndexed(supabase, userId, resolvedConversationId)
    activeHistoryContext = await retrieveHistoryContext({
      supabase,
      userId,
      conversationId: resolvedConversationId,
      projectId: project?.id ?? null,
      query: latestUserQuery(rawMessages),
      mode: historyRetrievalModeForTier(String(tier)),
    })
  }

  const effectiveSearchMode = searchMode === 'web' || searchMode === 'deep' ? searchMode : normalizeSearchMode(webSearch, deepWebSearch)
  const latestBeijingDate = latestBeijingDateFromMessages(rawMessages)
  const flags = { loggedIn: !!userId, searchMode: effectiveSearchMode, memoryEnabled, projectId: project?.id ?? null }
  const tools = activeTools(flags)
  const ctx: ToolContext = { supabase, userId, projectId: project?.id ?? null, searchMode: effectiveSearchMode, latestBeijingDate }
  const effectiveMemories = memoryEnabled && !project?.id ? (memories as Memory[] | undefined) : undefined
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
