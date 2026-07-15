import { NextRequest } from 'next/server'
import { apiErrorResponseV1 } from '@/lib/api/errors'
import { enforceRequestRateLimit, resolveAuth } from '@/lib/api/guard'
import { readJson, RequestError } from '@/lib/api/request'
import { expensiveWriteMaintenanceResponse } from '@/lib/api/maintenance'
import {
  JOB_RESUME_BODY_MAX_BYTES,
  parseResumeAwaitingJobCommand,
} from '@/lib/jobs/resume-command'
import { SupabaseJobRepository } from '@/lib/jobs/supabase-repository'
import { isUuid } from '@/lib/validation'

export async function POST(request: NextRequest, context: { params: Promise<{ jobId: string }> }) {
  const maintenance = expensiveWriteMaintenanceResponse(request)
  if (maintenance) return maintenance
  const auth = await resolveAuth()
  if (auth.authUnavailable) return apiErrorResponseV1(request, {
    status: 503, code: 'AUTH_DEPENDENCY_UNAVAILABLE', message: '认证服务暂时不可用', retryable: true,
    headers: { 'Retry-After': '5' },
  })
  if (!auth.userId) return apiErrorResponseV1(request, {
    status: 401, code: 'AUTH_REQUIRED', message: '请先登录', retryable: false,
  })
  const rate = await enforceRequestRateLimit(auth, request)
  if (rate.response) return apiErrorResponseV1(request, {
    status: rate.response.status,
    code: rate.response.status === 429 ? 'RATE_LIMITED' : 'DEPENDENCY_UNAVAILABLE',
    message: rate.response.status === 429 ? '请求过于频繁，请稍后再试' : '限流服务暂时不可用',
    retryable: true,
    headers: rate.response.headers.get('Retry-After')
      ? { 'Retry-After': rate.response.headers.get('Retry-After') as string }
      : undefined,
  })

  const { jobId } = await context.params
  if (!isUuid(jobId)) return apiErrorResponseV1(request, {
    status: 400, code: 'INVALID_REQUEST', message: 'jobId 无效', retryable: false,
  })

  let command: ReturnType<typeof parseResumeAwaitingJobCommand>
  try {
    const body = await readJson<unknown>(request, { maxBytes: JOB_RESUME_BODY_MAX_BYTES })
    command = parseResumeAwaitingJobCommand(body, request.headers.get('Idempotency-Key'))
  } catch (error) {
    const payloadTooLarge = error instanceof RequestError && error.status === 413
    return apiErrorResponseV1(request, {
      status: payloadTooLarge ? 413 : 400,
      code: payloadTooLarge ? 'PAYLOAD_TOO_LARGE' : 'INVALID_REQUEST',
      message: payloadTooLarge ? '恢复输入过大' : '恢复请求无效',
      retryable: false,
    })
  }

  try {
    const result = await new SupabaseJobRepository().resume({
      jobId,
      principalId: auth.userId,
      ...command,
    })
    if (!result.accepted) {
      if (result.reason === 'not_found') return apiErrorResponseV1(request, {
        status: 404, code: 'NOT_FOUND', message: '作业不存在', retryable: false,
      })
      return apiErrorResponseV1(request, {
        status: 409, code: 'CONFLICT', message: '作业当前无法恢复', retryable: false,
        details: {
          reason: result.reason,
          status: result.status,
          checkpointVersion: result.checkpointVersion,
        },
      })
    }
    return Response.json({
      jobId,
      resumed: true,
      replayed: result.replayed,
      status: result.status,
      checkpointVersion: result.checkpointVersion,
      eventSeq: result.eventSeq,
    }, {
      status: 202,
      headers: { 'Cache-Control': 'no-store', 'Retry-After': '1' },
    })
  } catch {
    return apiErrorResponseV1(request, {
      status: 503, code: 'DEPENDENCY_UNAVAILABLE', message: '作业恢复服务暂时不可用', retryable: true,
      headers: { 'Retry-After': '1' },
    })
  }
}
