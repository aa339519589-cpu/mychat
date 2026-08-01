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
import { expensiveWriteMaintenanceResponse } from '@/lib/api/maintenance'
import { log } from '@/lib/logger'
import type { DurableChatRequestBody } from '@/lib/llm/chat-request'
import type { AuthCtx } from '@/lib/api/guard'
import type { ChatModelSelection } from '@/lib/chat/model-selection'

function configurationError(
  request: Request,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): Response {
  return apiErrorResponseV1(request, {
    status: 503,
    code: 'DEPENDENCY_UNAVAILABLE',
    message,
    retryable: true,
    details,
    headers: { 'Retry-After': '5' },
  })
}

function admissionError(request: Request, error: unknown): Response {
  if (error instanceof JobPayloadStorageError) return configurationError(
    request,
    error.message,
    { storageCode: error.code },
  )
  if (!isJobRuntimeError(error)) return configurationError(request, '聊天任务入队失败')
  if (error.code === 'JOB_CONFLICT') return apiErrorResponseV1(request, {
    status: 409, code: 'CONFLICT', message: error.message, retryable: false, details: error.details,
  })
  if (error.code === 'JOB_INVALID_INPUT') return apiErrorResponseV1(request, {
    status: 400, code: 'INVALID_REQUEST', message: error.message, retryable: false, details: error.details,
  })
  if (!error.retryable) return apiErrorResponseV1(request, {
    status: 500,
    code: 'INTERNAL_ERROR',
    message: error.message,
    retryable: false,
    details: error.details,
  })
  return configurationError(request, error.message, error.details)
}

type AdmissionPolicy = {
  response?: Response
  selection?: ChatModelSelection
  usingBalance?: boolean
}

type AcceptedChatJob = Awaited<ReturnType<typeof enqueueChatJob>>

function acceptedChatResponse(input: {
  body: DurableChatRequestBody
  enqueued: AcceptedChatJob
  requestId: string
  startedAt: number
  authenticatedAt: number
  rateLimitedAt: number
  parsedAt: number
  policyResolvedAt: number
}): Response {
  const completedAt = Date.now()
  log.info('chat', 'Chat request admission timing', {
    requestId: input.requestId,
    jobId: input.enqueued.job.id,
    authMs: input.authenticatedAt - input.startedAt,
    rateLimitMs: input.rateLimitedAt - input.authenticatedAt,
    parseMs: input.parsedAt - input.rateLimitedAt,
    quotaAndModelPolicyMs: input.policyResolvedAt - input.parsedAt,
    enqueueMs: completedAt - input.policyResolvedAt,
    totalMs: completedAt - input.startedAt,
  })
  const streamUrl = `/api/v1/jobs/${input.enqueued.job.id}/events?from_seq=0`
  return Response.json({
    schemaVersion: 1,
    jobId: input.enqueued.job.id,
    generationId: input.enqueued.job.id,
    userMessageId: input.body.userMessageId,
    assistantMessageId: input.body.assistantMessageId,
    status: input.enqueued.job.status,
    created: input.enqueued.created,
    streamUrl,
  }, {
    status: 202,
    headers: {
      'Cache-Control': 'no-store',
      'Location': `/api/v1/jobs/${input.enqueued.job.id}`,
      'X-Idempotency-Key': `chat:${input.body.generationId}`,
    },
  })
}

async function resolveAdmissionPolicy(
  request: Request,
  auth: AuthCtx,
  body: DurableChatRequestBody,
): Promise<AdmissionPolicy> {
  const [quotaResult, selectionResult] = await Promise.allSettled([
    enforceQuotaLimit(auth, { quota: body.endpointId === undefined }),
    resolveChatModelSelection({
      tier: body.tier ?? '绝句',
      deepResearch: body.deepResearch === true,
      endpointId: body.endpointId,
      supabase: auth.supabase,
      userId: auth.userId,
    }),
  ])
  if (quotaResult.status === 'rejected') {
    return { response: configurationError(request, '额度服务暂时不可用') }
  }
  if (quotaResult.value.response) return { response: quotaResult.value.response }
  if (selectionResult.status === 'rejected') {
    const error = selectionResult.reason
    if (error instanceof ChatModelSelectionError) return {
      response: apiErrorResponseV1(request, {
        status: error.status,
        code: error.status === 404 ? 'NOT_FOUND'
          : error.status === 401 ? 'AUTH_REQUIRED'
            : 'CONFLICT',
        message: error.message,
        retryable: error.status >= 500,
      }),
    }
    return { response: configurationError(request, '模型策略暂时不可用') }
  }
  return {
    selection: selectionResult.value,
    usingBalance: quotaResult.value.usingBalance,
  }
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now()
  const traceId = requestId(request)
  const maintenance = expensiveWriteMaintenanceResponse(request)
  if (maintenance) return maintenance
  const auth = await resolveAuth(request)
  const authenticatedAt = Date.now()
  const rate = await enforceRequestRateLimit(auth, request)
  const rateLimitedAt = Date.now()
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
    body = validateChatRequest(await readJson(request, { maxBytes: 8 * 1024 * 1024 }))
    requireDurableChatIdentity(body)
  } catch (error) {
    return apiErrorResponseV1(request, {
      status: error instanceof RequestError ? error.status : 400,
      code: error instanceof RequestError && error.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_REQUEST',
      message: error instanceof Error ? error.message : '请求体格式错误',
      retryable: false,
    })
  }

  const parsedAt = Date.now()
  const policy = await resolveAdmissionPolicy(request, auth, body)
  if (policy.response) return policy.response
  const selection = policy.selection
  if (!selection || policy.usingBalance === undefined) {
    return configurationError(request, '聊天准入策略暂时不可用')
  }
  const policyResolvedAt = Date.now()
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
      usingBalance: policy.usingBalance,
      searchMode,
      outputKind: selection.outputKind,
      requestId: traceId,
    })
    return acceptedChatResponse({
      body,
      enqueued,
      requestId: traceId,
      startedAt,
      authenticatedAt,
      rateLimitedAt,
      parsedAt,
      policyResolvedAt,
    })
  } catch (error) {
    return admissionError(request, error)
  }
}
