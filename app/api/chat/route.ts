import { NextRequest } from 'next/server'
import { resolveDeepTierImageConfig, resolveDeepTierVideoConfig } from '@/lib/llm/models'
import { extractImagePrompt } from '@/lib/image-intent'
import { log } from '@/lib/logger'
import { readJson, requestErrorResponse } from '@/lib/api/request'
import { requireDurableChatIdentity, validateChatRequest } from '@/lib/llm/chat-request'
import {
  enforceQuotaLimit,
  enforceRequestRateLimit,
  getMemoryEnabled,
  resolveAuth,
} from '@/lib/api/guard'
import { normalizeSearchMode } from '@/lib/search-mode'
import { hasScannedPdfAttachment } from '@/lib/chat/attachments'
import { createDurableChatGenerationResponse } from '@/lib/chat/durable-generation'
import { createMediaGenerationResponse } from '@/lib/chat/media-response'
import { ChatModelSelectionError, resolveChatModelSelection } from '@/lib/chat/model-selection'
import { latestUserPrompt, latestUserSourceImages } from '@/lib/chat/request-context'
import { generationMaintenanceResponse } from '@/lib/generation/maintenance'

export async function POST(req: NextRequest) {
  const maintenance = generationMaintenanceResponse()
  if (maintenance) return maintenance

  // Authenticate and consume the shared request budget before buffering as much
  // as 48 MiB. The same auth context is reused for quota and all downstream work.
  const auth = await resolveAuth()
  const rateGate = await enforceRequestRateLimit(auth, req)
  if (rateGate.response) return rateGate.response
  const { supabase, userId } = auth
  if (!supabase || !userId) {
    return Response.json({ error: '请先建立登录或访客会话' }, { status: 401 })
  }

  let body
  try {
    body = validateChatRequest(await readJson(req, { maxBytes: 48 * 1024 * 1024 }))
    requireDurableChatIdentity(body)
  }
  catch (e) { return requestErrorResponse(e) }
  const {
    tier = '绝句',
    messages,
    attachments,
    searchMode,
    webSearch,
    deepWebSearch,
    deepResearch,
    endpointId,
    generateImage,
    generateVideo,
  } = body

  const quotaGate = await enforceQuotaLimit(auth, { quota: endpointId === undefined })
  if (quotaGate.response) return quotaGate.response
  let selection
  try {
    selection = await resolveChatModelSelection({
      tier,
      deepResearch: !!deepResearch,
      endpointId,
      supabase,
      userId,
    })
  } catch (error) {
    if (error instanceof ChatModelSelectionError) {
      if (error.logMessage) log.error('chat', error.logMessage)
      return error.toResponse()
    }
    throw error
  }
  const {
    customEndpoint,
    model,
    capability,
    apiKey,
    authType,
    outputKind,
  } = selection

  const memoryEnabled = await getMemoryEnabled(auth)
  const usingBalance = quotaGate.usingBalance
  const durable = {
    supabase,
    userId,
    generationId: body.generationId,
    conversationId: body.conversationId,
    assistantMessageId: body.assistantMessageId,
  }

  const rawMessages = messages
  const userPrompt = latestUserPrompt(rawMessages)
  // Media is selected explicitly via tiers 绘影/录像 (or legacy flags). No chat-model intent guessing.
  const wantPlatformImage = !customEndpoint && (generateImage === true || tier === '绘影')
  const wantPlatformVideo = !customEndpoint && (generateVideo === true || tier === '录像')
  const requestedSearchMode = searchMode === 'web' || searchMode === 'deep' ? searchMode : normalizeSearchMode(webSearch, deepWebSearch)
  const hasScannedAttachment = hasScannedPdfAttachment(attachments)
  if (customEndpoint && hasScannedAttachment) {
    return Response.json({ error: '自定义模型不会使用平台 OCR，请上传带文字层的 PDF 或文本文件' }, { status: 400 })
  }
  const sourceImages = latestUserSourceImages(rawMessages)
  const sourceImage = sourceImages[0]

  if (customEndpoint && outputKind !== 'chat') {
    const prompt = userPrompt
    if (!prompt && !sourceImage) {
      return Response.json({ error: '请输入描述，或附上参考图' }, { status: 400 })
    }
    return createMediaGenerationResponse({
      requestSignal: req.signal,
      durable,
      baseUrl: capability.provider.baseUrl,
      apiKey,
      authType: authType ?? 'bearer',
      model,
      outputKind,
      prompt,
      sourceImage,
      thinking: sourceImage
        ? (outputKind === 'image' ? '正在根据参考图生成图片……' : '正在根据参考图生成视频……')
        : (outputKind === 'image' ? '正在生成图片……' : '正在生成视频，这可能需要几分钟……'),
      successText: outputKind === 'image' ? '图片已生成。' : '视频已生成。',
    })
  }

  // Platform image: text-to-image or image edit (/images/edits) when a reference photo is attached
  if (wantPlatformImage) {
    const imageCfg = resolveDeepTierImageConfig()
    if (!imageCfg) {
      return Response.json({
        error: '平台生图未配置：请设置 DEEP_TIER_BASE_URL、DEEP_TIER_API_KEY，以及 DEEP_TIER_IMAGE_MODEL（或 DEEP_TIER_MODEL）',
      }, { status: 503 })
    }
    const prompt = extractImagePrompt(userPrompt)
    if (!prompt && !sourceImage) {
      return Response.json({ error: '请输入图片描述，或附上参考图' }, { status: 400 })
    }

    const logFields = {
      model: imageCfg.model,
      promptLen: prompt.length,
      hasSourceImage: !!sourceImage,
    }
    return createMediaGenerationResponse({
      requestSignal: req.signal,
      durable,
      baseUrl: imageCfg.baseUrl,
      apiKey: imageCfg.apiKey,
      authType: imageCfg.authType,
      model: imageCfg.model,
      outputKind: 'image',
      forceKind: 'image',
      prompt,
      sourceImage,
      thinking: sourceImage
        ? `正在用 ${imageCfg.model} 根据参考图生成……`
        : `正在用 ${imageCfg.model} 生成图片……`,
      successText: '图片已生成。',
      permissionError: `反代账号未开通生图权限（Image generation is not enabled for this group）。`
        + `模型已正确指向 ${imageCfg.model}，但当前 API Key 所属分组禁止图片接口。`
        + `请在反代后台为该 Key 开启图片权限，或换一把有 Imagine 权限的 Key。`,
      startLog: { event: 'platform image generation', fields: logFields },
      failureLog: {
        event: 'platform image generation failed',
        fields: { model: imageCfg.model },
      },
    })
  }

  // Platform video: text-to-video or image-to-video when a reference photo is attached
  if (wantPlatformVideo) {
    const videoCfg = resolveDeepTierVideoConfig()
    if (!videoCfg) {
      return Response.json({
        error: '平台生视频未配置：请设置 DEEP_TIER_BASE_URL、DEEP_TIER_API_KEY，以及 DEEP_TIER_VIDEO_MODEL',
      }, { status: 503 })
    }
    const prompt = extractImagePrompt(userPrompt)
    if (!prompt && !sourceImage) {
      return Response.json({ error: '请输入视频描述，或附上参考图' }, { status: 400 })
    }

    const logFields = {
      model: videoCfg.model,
      promptLen: prompt.length,
      hasSourceImage: !!sourceImage,
    }
    return createMediaGenerationResponse({
      requestSignal: req.signal,
      durable,
      baseUrl: videoCfg.baseUrl,
      apiKey: videoCfg.apiKey,
      authType: videoCfg.authType,
      model: videoCfg.model,
      outputKind: 'video',
      forceKind: 'video',
      prompt,
      sourceImage,
      thinking: sourceImage
        ? `正在用 ${videoCfg.model} 根据参考图生成视频，可能需要一分钟……`
        : `正在用 ${videoCfg.model} 生成视频，可能需要一分钟……`,
      successText: '视频已生成。',
      permissionError: `反代账号未开通视频生成权限。模型 ${videoCfg.model} 可用，但当前 Key 分组禁止视频接口。请在反代后台开启视频权限。`,
      startLog: { event: 'platform video generation', fields: logFields },
      failureLog: {
        event: 'platform video generation failed',
        fields: { model: videoCfg.model },
      },
    })
  }

  return createDurableChatGenerationResponse({
    requestSignal: req.signal,
    auth,
    body,
    selection,
    memoryEnabled,
    usingBalance,
    searchMode: requestedSearchMode,
    hasScannedAttachment,
  })
}
