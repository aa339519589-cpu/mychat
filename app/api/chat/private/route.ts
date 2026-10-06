import { NextRequest } from 'next/server'
import { resolveAuth, enforceRequestRateLimit, enforceQuotaLimit, type AuthCtx } from '@/lib/api/guard'
import { readJson, requestErrorResponse, RequestError } from '@/lib/api/request'
import { apiErrorResponseV1 } from '@/lib/api/errors'
import { expensiveWriteMaintenanceResponse } from '@/lib/api/maintenance'
import { validateChatRequest } from '@/lib/llm/chat-request'
import { resolveChatModelSelection, ChatModelSelectionError, type ChatModelSelection } from '@/lib/chat/model-selection'
import { usageLimitMessage } from '@/lib/chat/model-policy'
import { privateChatResponse, privateUsageIdentity } from '@/lib/chat/private-stream'
import { reserveTrialCall, releaseTrialCall } from '@/lib/chat/model-access'
import { createAdminClient } from '@/lib/supabase/admin'
import { parseJobRecord } from '@/lib/jobs/supabase-job-record'

type PrivateAuth = AuthCtx & { userId: string; supabase: NonNullable<AuthCtx['supabase']> }

function privateBody(value: unknown) {
  const body = validateChatRequest(value)
  if (!body.conversationId || body.endpointId || body.project || body.memories?.length || body.attachments?.length
    || body.connectorIds?.length || body.historyRetrieval === true || body.turn) {
    throw new RequestError(400, '私密聊天仅接收平台模型、当前消息和临时流标识')
  }
  return { ...body, conversationId: body.conversationId }
}

function authenticationResponse(request: Request, auth: AuthCtx): Response {
  const unavailable = auth.authUnavailable === true
  return apiErrorResponseV1(request, { status: unavailable ? 503 : 401,
    code: unavailable ? 'AUTH_DEPENDENCY_UNAVAILABLE' : 'AUTH_REQUIRED',
    message: '请先登录后使用私密聊天', retryable: unavailable })
}

async function admitPrivate(auth: PrivateAuth, selection: ChatModelSelection, identity: ReturnType<typeof privateUsageIdentity>) {
  const admin = createAdminClient()
  if (!admin) throw new Error('Private admission unavailable')
  const admitted = await admin.rpc('admit_private_chat_v1', { input_job_id: identity.jobId,
    input_principal_id: auth.userId, input_auth_class: auth.isAnonymous ? 'anonymous' : 'registered',
    input_model_id: selection.model, input_worker_id: identity.workerId,
    input_token_limit: selection.accessClass === 'trial' ? 30_000 : 160_000 })
  if (admitted.error?.message === 'insufficient_job_credit') throw new RequestError(403, '可用额度不足，请稍后重试')
  if (admitted.error) throw new Error('Private admission unavailable')
  const job = parseJobRecord(admitted.data, 'admit_private_chat_v1')
  if (!job.lease) throw new Error('Private lease missing')
  return { lease: { jobId: job.id, workerId: identity.workerId, leaseVersion: job.lease.version, attempt: job.attempt },
    tokenLimit: job.budget.tokenLimit ?? 160_000 }
}

async function reservePrivateTrial(auth: PrivateAuth, body: ReturnType<typeof privateBody>, selection: ChatModelSelection,
  identity: ReturnType<typeof privateUsageIdentity>): Promise<boolean> {
  if (!body.modelId || selection.accessClass === 'quota' || auth.isOwner) return false
  const trial = await reserveTrialCall(auth.supabase, auth.userId, identity.jobId, selection.model)
  if (!trial.allowed) throw new RequestError(403, usageLimitMessage(body.modelPolicy, '其他模型共享的 3 次额度已用完，请切换基础模型'))
  return !trial.duplicate
}

function privateFailure(request: Request, error: unknown): Response {
  if (error instanceof RequestError) return requestErrorResponse(error)
  if (error instanceof ChatModelSelectionError) return error.toResponse()
  return apiErrorResponseV1(request, { status: 503, code: 'DEPENDENCY_UNAVAILABLE',
    message: '私密聊天暂时不可用，请稍后重试', retryable: true })
}

export async function POST(request: NextRequest) {
  const maintenance = expensiveWriteMaintenanceResponse(request)
  if (maintenance) return maintenance
  const auth = await resolveAuth(request)
  if (!auth.userId || !auth.supabase) return authenticationResponse(request, auth)
  const privateAuth: PrivateAuth = { ...auth, userId: auth.userId, supabase: auth.supabase }
  const rate = await enforceRequestRateLimit(auth, request)
  if (rate.response) return rate.response
  const identity = privateUsageIdentity()
  let trialReserved = false
  try {
    const body = privateBody(await readJson(request, { maxBytes: 8 * 1024 * 1024 }))
    const selection = await resolveChatModelSelection({ tier: body.tier ?? '绝句', modelId: body.modelId,
      modelPolicy: body.modelPolicy,
      reasoningEffort: body.reasoningEffort, supabase: auth.supabase, userId: auth.userId, allowPremium: true })
    if (selection.outputKind !== 'chat') throw new RequestError(400, '私密聊天仅支持文字回复模型')
    const quota = await enforceQuotaLimit(auth, { quota: true })
    if (quota.response) return quota.response
    trialReserved = await reservePrivateTrial(privateAuth, body, selection, identity)
    const admission = await admitPrivate(privateAuth, selection, identity)
    return privateChatResponse({ request, body, selection, ...admission, usingBalance: quota.usingBalance })
  } catch (error) {
    if (trialReserved) await releaseTrialCall(auth.supabase, auth.userId, identity.jobId).catch(() => undefined)
    return privateFailure(request, error)
  }
}
