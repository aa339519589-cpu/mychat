import { NextRequest } from 'next/server'
import { apiErrorResponseV1 } from '@/lib/api/errors'
import { enforceQuotaLimit, enforceRequestRateLimit, resolveAuth } from '@/lib/api/guard'
import { readJson, requestId, RequestError } from '@/lib/api/request'
import { enqueueChatJob } from '@/lib/chat/job-command'
import { ChatModelSelectionError, resolveChatModelSelection } from '@/lib/chat/model-selection'
import { hasScannedPdfAttachment } from '@/lib/chat/attachments'
import { resolveDeepTierImageConfig, resolveDeepTierVideoConfig } from '@/lib/llm/models'
import { requireDurableChatIdentity, validateChatRequest } from '@/lib/llm/chat-request'
import { normalizeSearchMode } from '@/lib/search-mode'
import { isJobRuntimeError } from '@/lib/jobs/errors'
import { JobPayloadStorageError } from '@/lib/jobs/payload-storage'

function configurationError(request: Request, message: string): Response {
  return apiErrorResponseV1(request, {
    status: 503,
    code: 'DEPENDENCY_UNAVAILABLE',
    message,
    retryable: true,
    headers: { 'Retry-After': '5' },
  })
}

export async function POST(request: NextRequest) {
  const auth = await resolveAuth()
  const rate = await enforceRequestRateLimit(auth, request)
  if (rate.response) return rate.response
  if (!auth.supabase || !auth.userId) return apiErrorResponseV1(request, {
    status: auth.authUnavailable ? 503 : 401,
    code: auth.authUnavailable ? 'AUTH_DEPENDENCY_UNAVAILABLE' : 'AUTH_REQUIRED',
    message: auth.authUnavailable ? '认证服务暂时不可用' : '请先建立登录或访客会话',
    retryable: auth.authUnavailable === true,
    ...(auth.authUnavailable ? { headers: { 'Retry-After': '5' } } : {}),
  })

  let body
  try {
    body = validateChatRequest(await readJson(request, { maxBytes: 48 * 1024 * 1024 }))
    requireDurableChatIdentity(body)
  } catch (error) {
    return apiErrorResponseV1(request, {
      status: error instanceof RequestError ? error.status : 400,
      code: error instanceof RequestError && error.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_REQUEST',
      message: error instanceof Error ? error.message : '请求体格式错误',
      retryable: false,
    })
  }

  const quota = await enforceQuotaLimit(auth, { quota: body.endpointId === undefined })
  if (quota.response) return quota.response
  let selection
  try {
    selection = await resolveChatModelSelection({
      tier: body.tier ?? '绝句',
      deepResearch: body.deepResearch === true,
      endpointId: body.endpointId,
      supabase: auth.supabase,
      userId: auth.userId,
    })
  } catch (error) {
    if (error instanceof ChatModelSelectionError) return apiErrorResponseV1(request, {
      status: error.status,
      code: error.status === 404 ? 'NOT_FOUND' : error.status === 401 ? 'AUTH_REQUIRED' : 'CONFLICT',
      message: error.message,
      retryable: error.status >= 500,
    })
    return configurationError(request, '模型策略暂时不可用')
  }
  if (selection.customEndpoint && hasScannedPdfAttachment(body.attachments)) {
    return apiErrorResponseV1(request, {
      status: 400,
      code: 'INVALID_REQUEST',
      message: '自定义模型不会使用平台 OCR，请上传带文字层的 PDF 或文本文件',
      retryable: false,
    })
  }
  if (!selection.customEndpoint && selection.outputKind === 'image' && !resolveDeepTierImageConfig()) {
    return configurationError(request, '平台生图服务尚未配置')
  }
  if (!selection.customEndpoint && selection.outputKind === 'video' && !resolveDeepTierVideoConfig()) {
    return configurationError(request, '平台视频服务尚未配置')
  }

  const searchMode = body.searchMode === 'web' || body.searchMode === 'deep'
    ? body.searchMode
    : normalizeSearchMode(body.webSearch, body.deepWebSearch)
  try {
    const enqueued = await enqueueChatJob({
      body,
      userId: auth.userId,
      isAnonymous: auth.isAnonymous,
      usingBalance: quota.usingBalance,
      searchMode,
      outputKind: selection.outputKind,
      requestId: requestId(request),
    })
    const streamUrl = `/api/v1/jobs/${enqueued.job.id}/events?from_seq=0`
    return Response.json({
      schemaVersion: 1,
      jobId: enqueued.job.id,
      generationId: enqueued.job.id,
      userMessageId: body.userMessageId,
      assistantMessageId: body.assistantMessageId,
      status: enqueued.job.status,
      created: enqueued.created,
      streamUrl,
    }, {
      status: 202,
      headers: {
        'Cache-Control': 'no-store',
        'Location': `/api/v1/jobs/${enqueued.job.id}`,
        'X-Idempotency-Key': `chat:${body.generationId}`,
      },
    })
  } catch (error) {
    if (error instanceof JobPayloadStorageError) return configurationError(request, error.message)
    if (isJobRuntimeError(error) && error.code === 'JOB_CONFLICT') return apiErrorResponseV1(request, {
      status: 409, code: 'CONFLICT', message: error.message, retryable: false,
    })
    return configurationError(request, '作业控制面暂时不可用')
  }
}
