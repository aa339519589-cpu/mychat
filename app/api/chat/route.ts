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
import { customModelCapability, getModelCapability, type ModelCapability } from '@/lib/llm/models'
import { ensureImageSummaries } from '@/lib/llm/image-context'
import { ensureConversationIndexed, latestUserQuery, retrieveHistoryContext, type HistoryRetrievalMode } from '@/lib/llm/active-retrieval'
import { activeTools, toOpenAITools, execTool, type ToolContext } from '@/lib/tools'
import { log } from '@/lib/logger'
import { readJson, requestErrorResponse } from '@/lib/api/request'
import { validateChatRequest } from '@/lib/llm/chat-request'
import { addQuotaUsage } from '@/lib/quota'
import { ocrPageImages } from '@/lib/mimo'
import { resolveAuth, getMemoryEnabled, enforceLimits } from '@/lib/api/guard'
import { latestBeijingDateFromMessages, normalizeSearchMode } from '@/lib/search-mode'
import { prepareConversationSummary, RECENT_CONTEXT_MESSAGES } from '@/lib/llm/conversation-summary'
import { endpointAuthType, getOwnedModelEndpoint, resolveModelEndpointKey } from '@/lib/model-endpoint-server'
import { ModelEndpointError, validateModelEndpointNetwork } from '@/lib/llm/openai-compatible'
import { isModelOutputKind, type EndpointAuthType, type ModelOutputKind } from '@/lib/model-endpoints'
import { combineMediaGenerationSignals, generateOpenAICompatibleMedia, MediaGenerationError } from '@/lib/llm/media-generation'

const SAFETY_ROUNDS = 16
const MARKDOWN_DIVIDER_GUARD = '\n【排版补充】\n当回复有两个以上语义段落、步骤、转折或结论/解释分层时，优先用 Markdown 分隔线 "---" 做清晰分层。分隔线用于增强阅读节奏，不要滥用到每一句。'
const DEEP_RESEARCH_PREFIX = `请以最高努力完成当前问题：先理解真实目标，拆解约束，检查边界和反例，最后给出清晰结论。\n---\n`
function historyRetrievalModeForTier(tier: string): HistoryRetrievalMode {
  if (tier === '鸿篇') return 'deep'
  if (tier === '绝句') return 'light'
  return 'balanced'
}

function latestUserPrompt(messages: RawMsg[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== 'user') continue
    const text = typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
        ? message.content.map((part: any) => typeof part?.text === 'string' ? part.text : '').filter(Boolean).join('\n')
        : ''
    if (text.trim()) return text.trim().slice(0, 32_000)
  }
  return ''
}

async function ocrScannedPdfs(attachments?: any[], signal?: AbortSignal): Promise<any[]> {
  if (!attachments?.length) return attachments ?? []
  return Promise.all(attachments.map(async (f) => {
    if (!Array.isArray(f.pageImages) || !f.pageImages.length) return f
    const text = await ocrPageImages(f.pageImages, signal)
    log.info('ocrPdf', 'Scanned PDF OCR done', { name: f.name, pages: f.pageImages.length, textLen: text.length })
    return { ...f, text: text || '（扫描件识别失败，请重试或换一份更清晰的文件）', pageImages: undefined }
  }))
}

export async function POST(req: NextRequest) {
  let body
  try { body = validateChatRequest(await readJson(req, { maxBytes: 48 * 1024 * 1024 })) }
  catch (e) { return requestErrorResponse(e) }
  const { tier = '绝句', messages, memories, attachments, searchMode, webSearch, deepWebSearch, deepResearch, project, conversationId, historyRetrieval, endpointId } = body

  const auth = await resolveAuth()
  const { supabase, userId } = auth
  const customEndpoint = typeof endpointId === 'string'
  let model: string
  let thinking: boolean
  let capability: ModelCapability
  let apiKey: string
  let authType: EndpointAuthType | undefined
  let outputKind: ModelOutputKind = 'chat'
  let endpointDisplayName: string | undefined
  let platformTierLabel: string | undefined

  if (customEndpoint) {
    if (!supabase || !userId) return Response.json({ error: '请先登录后使用自定义模型' }, { status: 401 })
    try {
      const endpoint = await getOwnedModelEndpoint(supabase, userId, endpointId)
      if (!endpoint) return Response.json({ error: '自定义模型不存在或无权访问' }, { status: 404 })
      if (!isModelOutputKind(endpoint.output_kind)) {
        return Response.json({ error: '自定义模型用途无效，请在设置中重新连接' }, { status: 409 })
      }
      outputKind = endpoint.output_kind
      apiKey = resolveModelEndpointKey(endpoint, userId)
      const baseUrl = await validateModelEndpointNetwork(endpoint.base_url)
      model = endpoint.model
      endpointDisplayName = typeof endpoint.name === 'string' ? endpoint.name : undefined
      thinking = false
      authType = endpointAuthType(endpoint.auth_type)
      capability = customModelCapability(model, baseUrl)
    } catch (error) {
      if (error instanceof ModelEndpointError) {
        return Response.json({ error: error.message, stage: error.stage, code: error.code }, { status: error.status })
      }
      return Response.json({ error: error instanceof Error ? error.message : '自定义模型配置不可用' }, { status: 409 })
    }
  } else {
    const tierCfg = TIER_MAP[tier as keyof typeof TIER_MAP] ?? TIER_MAP['绝句']
    platformTierLabel = tierCfg.label
    model = deepResearch ? 'deepseek-v4-pro' : tierCfg.model
    thinking = deepResearch ? true : tierCfg.thinking
    capability = getModelCapability(model)
    const apiKeyEnv = capability.provider.apiKeyEnv
    apiKey = apiKeyEnv ? process.env[apiKeyEnv] ?? '' : ''
    if (!apiKey) {
      log.error('chat', `${apiKeyEnv ?? 'model key'} not configured`)
      return new Response(JSON.stringify({ error: `服务未配置（${apiKeyEnv ?? '模型 API Key'} 未设置）` }), { status: 500 })
    }
  }

  const memoryEnabled = await getMemoryEnabled(auth)
  const gate = await enforceLimits(auth, req, { quota: !customEndpoint })
  if (gate.response) return gate.response
  const usingBalance = gate.usingBalance

  const rawMessages = messages as RawMsg[]
  const requestedSearchMode = searchMode === 'web' || searchMode === 'deep' ? searchMode : normalizeSearchMode(webSearch, deepWebSearch)
  const hasScannedAttachment = Array.isArray(attachments) && attachments.some((attachment: any) => Array.isArray(attachment?.pageImages) && attachment.pageImages.length > 0)
  if (customEndpoint && requestedSearchMode !== 'off') {
    return Response.json({ error: '自定义模型不会使用平台的联网搜索额度，请关闭联网搜索后重试' }, { status: 400 })
  }
  if (customEndpoint && hasScannedAttachment) {
    return Response.json({ error: '自定义模型不会使用平台 OCR，请上传带文字层的 PDF 或文本文件' }, { status: 400 })
  }
  if (customEndpoint && outputKind !== 'chat') {
    const prompt = latestUserPrompt(rawMessages)
    if (!prompt) return Response.json({ error: '请输入图片或视频生成提示词' }, { status: 400 })

    let clientConnected = true
    const mediaAbort = new AbortController()
    const mediaSignal = combineMediaGenerationSignals(req.signal, mediaAbort.signal)
    const mediaStream = new ReadableStream({
      async start(controller) {
        const safeSend = (event: ChatEvent | { heartbeat: true }) => {
          if (!clientConnected) return
          try { send(controller, event) } catch {
            clientConnected = false
            mediaAbort.abort(new DOMException('Media stream closed', 'AbortError'))
          }
        }
        const heartbeat = setInterval(() => safeSend({ heartbeat: true }), 8_000)
        try {
          safeSend({ thinking: outputKind === 'image' ? '正在生成图片……' : '正在生成视频，这可能需要几分钟……' })
          const media = await generateOpenAICompatibleMedia({
            baseUrl: capability.provider.baseUrl,
            apiKey,
            authType: authType ?? 'bearer',
            model,
            outputKind,
            prompt,
            signal: mediaSignal,
          })
          safeSend({ media })
          safeSend({ text: outputKind === 'image' ? '图片已生成。' : '视频已生成。' })
        } catch (error) {
          const message = error instanceof MediaGenerationError
            ? error.message
            : networkError(error, '媒体生成服务', [apiKey])
          safeSend({ error: message })
        } finally {
          clearInterval(heartbeat)
          if (clientConnected) {
            try { done(controller) } catch { clientConnected = false }
          }
        }
      },
      cancel() {
        clientConnected = false
        mediaAbort.abort(new DOMException('Media stream cancelled', 'AbortError'))
      },
    })
    return new Response(mediaStream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } })
  }
  const summary = await prepareConversationSummary({
    supabase,
    userId,
    explicitConversationId: conversationId,
    messages: rawMessages,
    signal: req.signal,
    allowCompaction: !customEndpoint,
  })
  const resolvedConversationId = summary.conversationId
  const recentMessages = rawMessages.slice(-RECENT_CONTEXT_MESSAGES)
  const historyRetrievalEnabled = historyRetrieval === true
  let activeHistoryContext = ''
  if (historyRetrievalEnabled) {
    if (!customEndpoint) await ensureConversationIndexed(supabase, userId, resolvedConversationId, req.signal)
    activeHistoryContext = await retrieveHistoryContext({
      supabase,
      userId,
      conversationId: resolvedConversationId,
      projectId: project?.id ?? null,
      query: latestUserQuery(rawMessages),
      mode: customEndpoint ? 'light' : historyRetrievalModeForTier(String(tier)),
      signal: req.signal,
    })
  }

  const effectiveSearchMode = requestedSearchMode
  const latestBeijingDate = latestBeijingDateFromMessages(rawMessages)
  const flags = { loggedIn: !!userId, searchMode: effectiveSearchMode, memoryEnabled, projectId: project?.id ?? null }
  const tools = activeTools(flags)
  const ctx: ToolContext = { supabase, userId, projectId: project?.id ?? null, searchMode: effectiveSearchMode, latestBeijingDate, signal: req.signal }
  const effectiveMemories = memoryEnabled && !project?.id ? (memories as Memory[] | undefined) : undefined
  const url = chatCompletionsUrl(capability.provider.baseUrl)
  const SYSTEM = buildSystem(effectiveMemories, {
    searchMode: effectiveSearchMode,
    latestBeijingDate,
    memoryEnabled,
    project,
    modelSource: customEndpoint ? 'custom' : 'platform',
    tierLabel: customEndpoint ? null : platformTierLabel,
    modelId: customEndpoint ? model : null,
    endpointName: customEndpoint ? endpointDisplayName : null,
  })
    + summary.renderedSummary
    + activeHistoryContext
    + MARKDOWN_DIVIDER_GUARD
  const openaiTools = toOpenAITools(tools)

  let clientConnected = true
  const stream = new ReadableStream({
    async start(controller) {
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
        const preparedMessages = customEndpoint || capability.supportsImageInput
          ? recentMessages
          : await ensureImageSummaries(recentMessages, { supabase, userId, emit, signal: req.signal })
        const msgs: any[] = [{ role: 'system', content: SYSTEM }, ...buildModelContext(preparedMessages, capability)]
        if (deepResearch) {
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role !== 'user') continue
            const message = msgs[i]
            if (typeof message.content === 'string') {
              message.content = DEEP_RESEARCH_PREFIX + message.content
            } else if (Array.isArray(message.content)) {
              const textPart = message.content.find((part: any) => part.type === 'text')
              if (textPart) textPart.text = DEEP_RESEARCH_PREFIX + textPart.text
            }
            break
          }
        }
        const hasScanned = !customEndpoint && hasScannedAttachment
        if (hasScanned) emit({ thinking: '正在识别扫描件内容，请稍候……' })
        const processedAttachments = await ocrScannedPdfs(attachments, req.signal)
        await injectAttachmentsOpenAI(msgs, processedAttachments)
        await runAgentLoop({
          url, apiKey, model, adapter: capability.provider.adapter, thinking,
          messages: msgs, tools: openaiTools, emit, executeTool,
          maxRounds: SAFETY_ROUNDS,
          leakedRetry: true,
          autoContinue: { maxContinuations: 4 },
          onUsage: total => { totalTokensUsed = total },
          turnOptions: { signal: req.signal, timeoutMs: 120_000, authType },
          onTurn: ({ phase, round, turn }) => log.info('chat', `Turn ${phase}`, { round, finishReason: turn.finishReason, leaked: turn.leaked, toolCalls: turn.toolCalls.length, contentLen: turn.content.length, truncated: turn.truncated }),
        })
      } catch (error) {
        emit({ error: networkError(error, '模型服务', [apiKey]) })
      } finally {
        clearInterval(heartbeat)
        if (!customEndpoint && userId && supabase) await addQuotaUsage(supabase, userId, totalTokensUsed, model, thinking, usingBalance)
        if (clientConnected) {
          try { done(controller) } catch { clientConnected = false }
        }
      }
    },
    cancel() { clientConnected = false },
  })
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } })
}
