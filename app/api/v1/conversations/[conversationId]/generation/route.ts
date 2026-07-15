import { NextRequest } from 'next/server'
import { apiErrorResponseV1 } from '@/lib/api/errors'
import { resolveAuth } from '@/lib/api/guard'
import { readLatestOwnedConversationJob } from '@/lib/jobs/read-model'
import { isUuid } from '@/lib/validation'

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ conversationId: string }> },
) {
  const auth = await resolveAuth()
  if (auth.authUnavailable) return apiErrorResponseV1(request, {
    status: 503,
    code: 'AUTH_DEPENDENCY_UNAVAILABLE',
    message: '认证服务暂时不可用',
    retryable: true,
    headers: { 'Retry-After': '5' },
  })
  if (!auth.supabase || !auth.userId) return apiErrorResponseV1(request, {
    status: 401, code: 'AUTH_REQUIRED', message: '请先登录', retryable: false,
  })
  const { conversationId } = await context.params
  if (!isUuid(conversationId)) return apiErrorResponseV1(request, {
    status: 400, code: 'INVALID_REQUEST', message: 'conversationId 无效', retryable: false,
  })
  const result = await readLatestOwnedConversationJob(
    auth.supabase,
    auth.userId,
    conversationId,
    request.signal,
  )
  if (!result.ok) return apiErrorResponseV1(request, {
    status: 503,
    code: 'DEPENDENCY_UNAVAILABLE',
    message: '生成作业状态暂时不可用',
    retryable: true,
    headers: { 'Retry-After': '1' },
  })
  return Response.json({
    job: result.value,
    streamUrl: result.value ? `/api/v1/jobs/${result.value.id}/events?from_seq=0` : null,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
