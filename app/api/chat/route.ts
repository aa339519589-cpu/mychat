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
import { customModelCapability, getModelCapability, resolveDeepTierImageConfig, resolveDeepTierVideoConfig, type ModelCapability } from '@/lib/llm/models'
import { extractImagePrompt } from '@/lib/image-intent'
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
import { createGeneration, appendText, appendThinking, setStatus, getAbortSignal, maybeGc, getGeneration } from '@/lib/generation/runtime'
import { persistAssistantMessage, persistGenerationRow } from '@/lib/generation/persist'

const SAFETY_ROUNDS = 16

/** Map product mode → Grok reasoning intensity. Grok 4.5 cannot fully disable reasoning. */
function resolveReasoningEffort(opts: {
  isDeepTierProxy: boolean
  deepResearch: boolean
  modelId: string
}): 'low' | 'medium' | 'high' | null {
  if (!opts.isDeepTierProxy && !/^grok/i.test(opts.modelId)) return null
  if (opts.deepResearch) return 'high'
  const fromEnv = (process.env.DEEP_TIER_REASONING_EFFORT ?? 'low').trim().toLowerCase()
  if (fromEnv === 'low' || fromEnv === 'medium' || fromEnv === 'high' || fromEnv === 'none') {
    return fromEnv === 'none' ? 'low' : fromEnv // 4.5 cannot none; clamp to low
  }
  return 'low'
}

const DEEP_RESEARCH_PREFIX = `请以最高努力完成当前问题：先理解真实目标，拆解约束，检查边界和反例，最后给出清晰结论。\n---\n`
function historyRetrievalModeForTier(tier: string): HistoryRetrievalMode {
  if (tier === '鸿篇') return 'deep'
  if (tier === '绝句' || tier === '绘影' || tier === '录像') return 'light'
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
  const { tier = '绝句', messages, memories, attachments, searchMode, webSearch, deepWebSearch, deepResearch, project, conversationId, historyRetrieval, endpointId, generationId: bodyGenerationId, assistantMessageId, generateImage, generateVideo } = body

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
    // 图片/视频档：不走聊天模型，也不要求 DeepSeek Key
    if (tierCfg.id === '绘影' || tierCfg.id === '录像') {
      model = tierCfg.model
      thinking = false
      capability = customModelCapability(tierCfg.model, process.env.DEEP_TIER_BASE_URL?.trim() || 'https://invalid.local')
      apiKey = process.env.DEEP_TIER_API_KEY?.trim() || ''
      authType = (process.env.DEEP_TIER_AUTH_TYPE as EndpointAuthType | undefined) || 'bearer'
      outputKind = tierCfg.id === '绘影' ? 'image' : 'video'
    } else {
      // 深度研究与「深度」档共用 platform-deep（可配反代 Grok；未配则 DeepSeek Pro）
      const modelKey = (deepResearch || tierCfg.id === '鸿篇') ? 'platform-deep' : tierCfg.model
      capability = getModelCapability(modelKey)
      model = capability.id
      thinking = capability.supportsThinking && (deepResearch || tierCfg.thinking)
      authType = capability.provider.authType
      const apiKeyEnv = capability.provider.apiKeyEnv
      apiKey = apiKeyEnv ? process.env[apiKeyEnv] ?? '' : ''
      if (!apiKey) {
        log.error('chat', `${apiKeyEnv ?? 'model key'} not configured`)
        return new Response(JSON.stringify({ error: `服务未配置（${apiKeyEnv ?? '模型 API Key'} 未设置）` }), { status: 500 })
      }
    }
  }

  const [memoryEnabled, gate] = await Promise.all([
    getMemoryEnabled(auth),
    enforceLimits(auth, req, { quota: !customEndpoint }),
  ])
  if (gate.response) return gate.response
  const usingBalance = gate.usingBalance

  const rawMessages = messages as RawMsg[]
  const userPrompt = latestUserPrompt(rawMessages)
  // Media is selected explicitly via tiers 绘影/录像 (or legacy flags). No chat-model intent guessing.
  const wantPlatformImage = !customEndpoint && (generateImage === true || tier === '绘影')
  const wantPlatformVideo = !customEndpoint && (generateVideo === true || tier === '录像')
  const requestedSearchMode = searchMode === 'web' || searchMode === 'deep' ? searchMode : normalizeSearchMode(webSearch, deepWebSearch)
  const hasScannedAttachment = Array.isArray(attachments) && attachments.some((attachment: any) => Array.isArray(attachment?.pageImages) && attachment.pageImages.length > 0)
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

  // Platform deep-tier reverse-proxy image generation (Grok Imagine via OpenAI-compatible /images/generations)
  if (wantPlatformImage) {
    const imageCfg = resolveDeepTierImageConfig()
    if (!imageCfg) {
      return Response.json({
        error: '平台生图未配置：请设置 DEEP_TIER_BASE_URL、DEEP_TIER_API_KEY，以及 DEEP_TIER_IMAGE_MODEL（或 DEEP_TIER_MODEL）',
      }, { status: 503 })
    }
    const prompt = extractImagePrompt(userPrompt || latestUserPrompt(rawMessages))
    if (!prompt) return Response.json({ error: '请输入图片生成提示词' }, { status: 400 })

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
          safeSend({ thinking: `正在用 ${imageCfg.model} 生成图片……` })
          log.info('chat', 'platform image generation', {
            model: imageCfg.model,
            baseUrl: imageCfg.baseUrl,
            promptLen: prompt.length,
          })
          const media = await generateOpenAICompatibleMedia({
            baseUrl: imageCfg.baseUrl,
            apiKey: imageCfg.apiKey,
            authType: imageCfg.authType,
            model: imageCfg.model,
            outputKind: 'image',
            forceKind: 'image',
            prompt,
            signal: mediaSignal,
          })
          safeSend({ media })
          safeSend({ text: '图片已生成。' })
        } catch (error) {
          let message = error instanceof MediaGenerationError
            ? error.message
            : networkError(error, '媒体生成服务', [imageCfg.apiKey])
          if (/not enabled for this group|permission/i.test(message)) {
            message = `反代账号未开通生图权限（Image generation is not enabled for this group）。`
              + `模型已正确指向 ${imageCfg.model}，但当前 API Key 所属分组禁止 /images/generations。`
              + `请在反代后台为该 Key 开启图片权限，或换一把有 Imagine 权限的 Key。`
          }
          log.error('chat', 'platform image generation failed', { model: imageCfg.model, message })
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

  // Platform video: explicit 录像 tier only — POST /videos/generations + poll GET /videos/{id}
  if (wantPlatformVideo) {
    const videoCfg = resolveDeepTierVideoConfig()
    if (!videoCfg) {
      return Response.json({
        error: '平台生视频未配置：请设置 DEEP_TIER_BASE_URL、DEEP_TIER_API_KEY，以及 DEEP_TIER_VIDEO_MODEL',
      }, { status: 503 })
    }
    const prompt = extractImagePrompt(userPrompt || latestUserPrompt(rawMessages))
    if (!prompt) return Response.json({ error: '请输入视频生成提示词' }, { status: 400 })

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
          safeSend({ thinking: `正在用 ${videoCfg.model} 生成视频，可能需要一分钟……` })
          log.info('chat', 'platform video generation', {
            model: videoCfg.model,
            baseUrl: videoCfg.baseUrl,
            promptLen: prompt.length,
          })
          const media = await generateOpenAICompatibleMedia({
            baseUrl: videoCfg.baseUrl,
            apiKey: videoCfg.apiKey,
            authType: videoCfg.authType,
            model: videoCfg.model,
            outputKind: 'video',
            forceKind: 'video',
            prompt,
            signal: mediaSignal,
          })
          safeSend({ media })
          safeSend({ text: '视频已生成。' })
        } catch (error) {
          let message = error instanceof MediaGenerationError
            ? error.message
            : networkError(error, '媒体生成服务', [videoCfg.apiKey])
          if (/not enabled for this group|permission/i.test(message)) {
            message = `反代账号未开通视频生成权限。模型 ${videoCfg.model} 可用，但当前 Key 分组禁止视频接口。请在反代后台开启视频权限。`
          }
          log.error('chat', 'platform video generation failed', { model: videoCfg.model, message })
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

  const effectiveSearchMode = requestedSearchMode
  const latestBeijingDate = latestBeijingDateFromMessages(rawMessages)

  // Durable generation: continues after browser disconnect; only explicit cancel aborts model.
  const generationId = typeof bodyGenerationId === 'string' && bodyGenerationId
    ? bodyGenerationId
    : crypto.randomUUID()
  const assistantId = typeof assistantMessageId === 'string' && assistantMessageId
    ? assistantMessageId
    : crypto.randomUUID()
  const convIdForGen = typeof conversationId === 'string' && conversationId ? conversationId : 'unknown'
  if (userId) {
    createGeneration({
      id: generationId,
      userId,
      conversationId: convIdForGen,
      assistantMessageId: assistantId,
    })
    setStatus(generationId, 'running')
  }
  const generationSignal = getAbortSignal(generationId)

  // 自接 OpenAI 兼容网关经常不支持 tools：无联网时不挂工具，避免「带 tools 失败 → 再重试」双倍延迟。
  const flags = {
    loggedIn: !!userId,
    searchMode: effectiveSearchMode,
    memoryEnabled: customEndpoint ? false : memoryEnabled,
    projectId: customEndpoint ? null : (project?.id ?? null),
  }
  const tools = activeTools(flags)
  // Tools use generation signal so disconnect does not cancel tool mid-flight incorrectly via req.signal
  const ctx: ToolContext = { supabase, userId, projectId: project?.id ?? null, searchMode: effectiveSearchMode, latestBeijingDate, signal: generationSignal }
  const effectiveMemories = (!customEndpoint && memoryEnabled && !project?.id) ? (memories as Memory[] | undefined) : undefined
  const url = chatCompletionsUrl(capability.provider.baseUrl)
  const openaiTools = toOpenAITools(tools)
  const recentMessages = rawMessages.slice(-RECENT_CONTEXT_MESSAGES)
  const historyRetrievalEnabled = historyRetrieval === true
  const isDeepTierProxy = capability.provider.id === 'deep-tier'
  const reasoningEffort = resolveReasoningEffort({
    isDeepTierProxy,
    deepResearch: !!deepResearch,
    modelId: model,
  })
  if (reasoningEffort) {
    log.info('chat', 'reasoning effort', {
      model,
      reasoningEffort,
      deepResearch: !!deepResearch,
      adapter: capability.provider.adapter,
    })
  }


  let clientConnected = true
  // Client disconnect must NOT cancel generation — only stop writing SSE.
  req.signal.addEventListener('abort', () => {
    clientConnected = false
    log.info('generation', 'stream disconnected (client)', {
      generationId,
      conversationId: convIdForGen,
      assistantMessageId: assistantId,
    })
  }, { once: true })

  const stream = new ReadableStream({
    async start(controller) {
      const safeSend = (event: ChatEvent | { heartbeat: true } | { generationId: string; assistantMessageId: string }) => {
        if (!clientConnected) return
        try { send(controller, event as any) } catch { clientConnected = false }
      }
      const emit: Emit = (e) => {
        if (e && typeof e === 'object' && 'text' in e && typeof (e as any).text === 'string') {
          appendText(generationId, (e as any).text)
        }
        if (e && typeof e === 'object' && 'thinking' in e && typeof (e as any).thinking === 'string') {
          appendThinking(generationId, (e as any).thinking)
        }
        safeSend(e)
      }
      let totalTokensUsed = 0
      let lastPersistAt = 0
      const persistProgress = async (force = false) => {
        if (!supabase || !userId) return
        const entry = getGeneration(generationId)
        if (!entry) return
        const now = Date.now()
        if (!force && now - lastPersistAt < 800) return
        lastPersistAt = now
        await persistAssistantMessage(supabase as any, assistantId, {
          content: entry.record.content,
          thinking: entry.record.thinking || null,
        })
        await persistGenerationRow(supabase as any, {
          id: entry.record.id,
          userId: entry.record.userId,
          conversationId: entry.record.conversationId,
          assistantMessageId: entry.record.assistantMessageId,
          status: entry.record.status,
          content: entry.record.content,
          thinking: entry.record.thinking,
          sequence: entry.record.sequence,
          error: entry.record.error,
        })
      }

      safeSend({ heartbeat: true })
      safeSend({ generationId, assistantMessageId: assistantId } as any)
      const heartbeat = setInterval(() => safeSend({ heartbeat: true }), 8_000)
      const persistTimer = setInterval(() => { void persistProgress(false) }, 1000)
      const executeTool: ExecuteTool = async (name, input) => {
        const { result, event } = await execTool(tools, name, input, ctx)
        if (event) emit(event as ChatEvent)
        return result
      }
      try {
        const summary = await prepareConversationSummary({
          supabase,
          userId,
          explicitConversationId: conversationId,
          messages: rawMessages,
          signal: generationSignal,
          allowCompaction: !customEndpoint,
        })
        const resolvedConversationId = summary.conversationId
        let activeHistoryContext = ''
        if (historyRetrievalEnabled) {
          if (!customEndpoint) await ensureConversationIndexed(supabase, userId, resolvedConversationId, generationSignal)
          activeHistoryContext = await retrieveHistoryContext({
            supabase,
            userId,
            conversationId: resolvedConversationId,
            projectId: project?.id ?? null,
            query: latestUserQuery(rawMessages),
            mode: customEndpoint ? 'light' : historyRetrievalModeForTier(String(tier)),
            signal: generationSignal,
          })
        }
        const SYSTEM = buildSystem(effectiveMemories, {
          searchMode: effectiveSearchMode,
          latestBeijingDate,
          memoryEnabled: customEndpoint ? false : memoryEnabled,
          project: customEndpoint ? undefined : project,
          modelSource: customEndpoint ? 'custom' : 'platform',
          tierLabel: customEndpoint ? null : platformTierLabel,
          modelId: customEndpoint ? model : null,
          endpointName: customEndpoint ? endpointDisplayName : null,
        })
          + summary.renderedSummary
          + activeHistoryContext

        const preparedMessages = customEndpoint || capability.supportsImageInput
          ? recentMessages
          : await ensureImageSummaries(recentMessages, { supabase, userId, emit, signal: generationSignal })
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
        const processedAttachments = await ocrScannedPdfs(attachments, generationSignal)
        await injectAttachmentsOpenAI(msgs, processedAttachments)
        log.info('generation', 'stream connected', {
          generationId,
          conversationId: convIdForGen,
          assistantMessageId: assistantId,
          status: 'running',
        })
        await runAgentLoop({
          url, apiKey, model, adapter: capability.provider.adapter, thinking,
          reasoningEffort,
          messages: msgs, tools: openaiTools, emit, executeTool,
          maxRounds: SAFETY_ROUNDS,
          leakedRetry: true,
          autoContinue: { maxContinuations: 4 },
          onUsage: total => { totalTokensUsed = total },
          // IMPORTANT: generation signal only — client disconnect does not cancel model.
          turnOptions: {
            signal: generationSignal,
            timeoutMs: 120_000,
            authType,
            logTiming: isDeepTierProxy || process.env.DEBUG_LLM_TIMING === '1',
          },
          onTurn: ({ phase, round, turn }) => log.info('chat', `Turn ${phase}`, { round, finishReason: turn.finishReason, leaked: turn.leaked, toolCalls: turn.toolCalls.length, contentLen: turn.content.length, truncated: turn.truncated }),
        })
        if (generationSignal?.aborted) {
          setStatus(generationId, 'cancelled')
        } else {
          setStatus(generationId, 'completed')
        }
      } catch (error) {
        const msg = networkError(error, '模型服务', [apiKey])
        if (generationSignal?.aborted) {
          setStatus(generationId, 'cancelled')
        } else {
          setStatus(generationId, 'failed', msg)
          emit({ error: msg })
        }
      } finally {
        clearInterval(heartbeat)
        clearInterval(persistTimer)
        await persistProgress(true)
        if (!customEndpoint && userId && supabase) await addQuotaUsage(supabase, userId, totalTokensUsed, model, thinking, usingBalance)
        if (clientConnected) {
          try { done(controller) } catch { clientConnected = false }
        }
        maybeGc(generationId)
      }
    },
    cancel() {
      // Browser closed SSE — do not abort generation.
      clientConnected = false
    },
  })
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } })
}
