import { NextRequest } from 'next/server'
import { apiErrorResponseV1 } from '@/lib/api/errors'
import { resolveAuth } from '@/lib/api/guard'
import { readOwnedJob } from '@/lib/jobs/read-model'
import { isUuid } from '@/lib/validation'

export async function GET(request: NextRequest, context: { params: Promise<{ jobId: string }> }) {
  const auth = await resolveAuth()
  if (auth.authUnavailable) return apiErrorResponseV1(request, {
    status: 503, code: 'AUTH_DEPENDENCY_UNAVAILABLE', message: '认证服务暂时不可用', retryable: true,
    headers: { 'Retry-After': '5' },
  })
  if (!auth.supabase || !auth.userId) return apiErrorResponseV1(request, {
    status: 401, code: 'AUTH_REQUIRED', message: '请先登录', retryable: false,
  })
  const { jobId } = await context.params
  if (!isUuid(jobId)) return apiErrorResponseV1(request, {
    status: 400, code: 'INVALID_REQUEST', message: 'jobId 无效', retryable: false,
  })
  const result = await readOwnedJob(auth.supabase, auth.userId, jobId)
  if (!result.ok) return apiErrorResponseV1(request, result.kind === 'not_found' ? {
    status: 404, code: 'NOT_FOUND', message: '作业不存在', retryable: false,
  } : {
    status: 503, code: 'DEPENDENCY_UNAVAILABLE', message: '作业状态暂时不可用', retryable: true,
    headers: { 'Retry-After': '1' },
  })
  return Response.json({ job: result.value }, { headers: { 'Cache-Control': 'no-store' } })
}
