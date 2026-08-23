import { NextRequest } from 'next/server'
import { apiErrorResponseV1 } from '@/lib/api/errors'
import { readJson, RequestError } from '@/lib/api/request'
import { SupabaseJobRepository } from '@/lib/jobs/supabase-repository'
import {
  chatGptBridgeConfigured,
  issueChatGptClaimToken,
  verifyChatGptPairToken,
} from '@/lib/chatgpt-bridge/auth'
import { bearerToken, chatGptBridgeQueue, chatGptBridgeWorkerId } from '@/lib/chatgpt-bridge/queue'

function validClientId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 8 && value.length <= 128
    && !/[\u0000-\u001f\u007f]/.test(value)
}

export async function POST(request: NextRequest) {
  if (!chatGptBridgeConfigured()) return apiErrorResponseV1(request, {
    status: 503,
    code: 'DEPENDENCY_UNAVAILABLE',
    message: 'ChatGPT 网页桥接未配置',
    retryable: false,
  })
  const pair = verifyChatGptPairToken(bearerToken(request))
  if (!pair) return apiErrorResponseV1(request, {
    status: 401,
    code: 'AUTH_REQUIRED',
    message: 'ChatGPT 网页桥接配对已失效',
    retryable: false,
  })

  let body: Record<string, unknown>
  try { body = await readJson(request, { maxBytes: 16 * 1024 }) }
  catch (error) {
    return apiErrorResponseV1(request, {
      status: error instanceof RequestError ? error.status : 400,
      code: 'INVALID_REQUEST',
      message: '桥接请求无效',
      retryable: false,
    })
  }
  if (!validClientId(body.clientId)) return apiErrorResponseV1(request, {
    status: 400,
    code: 'INVALID_REQUEST',
    message: 'clientId 无效',
    retryable: false,
  })

  const repository = new SupabaseJobRepository()
  const workerId = chatGptBridgeWorkerId(pair.sub, body.clientId)
  const claimed = await repository.claim({
    workerId,
    queues: [chatGptBridgeQueue(pair.sub)],
    leaseSeconds: 900,
  })
  if (!claimed.acquired || !claimed.job) {
    return Response.json({ job: null }, { headers: { 'Cache-Control': 'no-store' } })
  }

  const job = claimed.job
  if (job.principal.id !== pair.sub || job.type !== 'chatgpt.web.turn' || !job.lease) {
    if (job.lease) await repository.finalize({
      jobId: job.id,
      workerId: job.lease.owner,
      leaseVersion: job.lease.version,
      status: 'failed',
      error: {
        code: 'CHATGPT_BRIDGE_JOB_INVALID',
        message: 'ChatGPT bridge claimed an invalid job',
        retryable: false,
        class: 'internal',
        details: {},
      },
    })
    return apiErrorResponseV1(request, {
      status: 409,
      code: 'CONFLICT',
      message: '桥接队列状态异常',
      retryable: true,
    })
  }

  const claimToken = issueChatGptClaimToken({
    principalId: pair.sub,
    jobId: job.id,
    workerId: job.lease.owner,
    leaseVersion: job.lease.version,
  })
  return Response.json({
    job: {
      id: job.id,
      input: job.input,
      attempt: job.attempt,
      claimToken,
      leaseExpiresAt: job.lease.expiresAt,
    },
  }, { headers: { 'Cache-Control': 'no-store' } })
}
