import { NextRequest } from 'next/server'
import { apiErrorResponseV1 } from '@/lib/api/errors'
import { enforceRequestRateLimit, resolveAuth } from '@/lib/api/guard'
import { readJson, RequestError } from '@/lib/api/request'
import { SupabaseJobRepository } from '@/lib/jobs/supabase-repository'
import { isUuid } from '@/lib/validation'

export async function POST(request: NextRequest, context: { params: Promise<{ jobId: string }> }) {
  const auth = await resolveAuth()
  if (auth.authUnavailable) return apiErrorResponseV1(request, {
    status: 503, code: 'AUTH_DEPENDENCY_UNAVAILABLE', message: '认证服务暂时不可用', retryable: true,
    headers: { 'Retry-After': '5' },
  })
  if (!auth.userId) return apiErrorResponseV1(request, {
    status: 401, code: 'AUTH_REQUIRED', message: '请先登录', retryable: false,
  })
  const rate = await enforceRequestRateLimit(auth, request)
  if (rate.response) return rate.response
  const { jobId } = await context.params
  if (!isUuid(jobId)) return apiErrorResponseV1(request, {
    status: 400, code: 'INVALID_REQUEST', message: 'jobId 无效', retryable: false,
  })
  let reason: string | undefined
  if (request.body && request.headers.get('content-length') !== '0') {
    try {
      const body = await readJson<Record<string, unknown>>(request, { maxBytes: 4 * 1024 })
      if (body.reason !== undefined && (typeof body.reason !== 'string' || body.reason.length > 500)) {
        throw new RequestError(400, 'reason 无效')
      }
      reason = typeof body.reason === 'string' ? body.reason : undefined
    } catch (error) {
      return apiErrorResponseV1(request, {
        status: error instanceof RequestError ? error.status : 400,
        code: 'INVALID_REQUEST', message: error instanceof Error ? error.message : '请求体无效', retryable: false,
      })
    }
  }
  try {
    const result = await new SupabaseJobRepository().cancel({
      jobId,
      principalId: auth.userId,
      reason,
    })
    const terminal = result.status === 'completed' || result.status === 'failed' || result.status === 'cancelled'
    return Response.json({ jobId, ...result }, {
      status: terminal ? 200 : 202,
      headers: { 'Cache-Control': 'no-store', ...(terminal ? {} : { 'Retry-After': '1' }) },
    })
  } catch {
    return apiErrorResponseV1(request, {
      status: 503, code: 'DEPENDENCY_UNAVAILABLE', message: '取消服务暂时不可用', retryable: true,
      headers: { 'Retry-After': '1' },
    })
  }
}
