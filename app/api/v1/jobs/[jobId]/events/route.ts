import { NextRequest } from 'next/server'
import { apiErrorResponseV1 } from '@/lib/api/errors'
import { resolveAuth } from '@/lib/api/guard'
import { createJobEventStream } from '@/lib/jobs/event-stream'
import { readOwnedJob } from '@/lib/jobs/read-model'
import { isUuid } from '@/lib/validation'

const SEQUENCE = /^(?:0|[1-9][0-9]{0,15})$/

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
  const requestedSequence = new URL(request.url).searchParams.get('from_seq')
    ?? request.headers.get('last-event-id') ?? '0'
  if (!isUuid(jobId) || !SEQUENCE.test(requestedSequence)) return apiErrorResponseV1(request, {
    status: 400, code: 'INVALID_REQUEST', message: '作业订阅参数无效', retryable: false,
  })
  const fromSequence = Number(requestedSequence)
  if (!Number.isSafeInteger(fromSequence)) return apiErrorResponseV1(request, {
    status: 400, code: 'INVALID_REQUEST', message: 'from_seq 无效', retryable: false,
  })
  const result = await readOwnedJob(auth.supabase, auth.userId, jobId)
  if (!result.ok) return apiErrorResponseV1(request, result.kind === 'not_found' ? {
    status: 404, code: 'NOT_FOUND', message: '作业不存在', retryable: false,
  } : {
    status: 503, code: 'DEPENDENCY_UNAVAILABLE', message: '作业事件暂时不可用', retryable: true,
    headers: { 'Retry-After': '1' },
  })
  const stream = createJobEventStream({
    client: auth.supabase,
    principalId: auth.userId,
    jobId,
    fromSequence,
    initialStatus: result.value.status,
    requestSignal: request.signal,
  })
  return new Response(stream, { headers: {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  } })
}
