import { NextRequest } from 'next/server'
import { apiErrorResponseV1 } from '@/lib/api/errors'
import { enforceRequestRateLimit, resolveAuth } from '@/lib/api/guard'
import { isTerminalJobStatus } from '@/lib/jobs/contracts'
import { SupabaseJobRepository } from '@/lib/jobs/supabase-repository'
import { isUuid } from '@/lib/validation'

export async function DELETE(request: NextRequest, context: { params: Promise<{ jobId: string }> }) {
  const auth = await resolveAuth(request)
  if (auth.authUnavailable) return apiErrorResponseV1(request, {
    status: 503, code: 'AUTH_DEPENDENCY_UNAVAILABLE', message: '认证服务暂时不可用', retryable: true,
    headers: { 'Retry-After': '5' },
  })
  if (!auth.supabase || !auth.userId) return apiErrorResponseV1(request, {
    status: 401, code: 'AUTH_REQUIRED', message: '请先登录', retryable: false,
  })
  const rate = await enforceRequestRateLimit(auth, request)
  if (rate.response) return rate.response

  const { jobId } = await context.params
  if (!isUuid(jobId)) return apiErrorResponseV1(request, {
    status: 400, code: 'INVALID_REQUEST', message: 'jobId 无效', retryable: false,
  })

  const { data, error } = await auth.supabase.from('jobs')
    .select('id,type,status')
    .eq('id', jobId).eq('principal_id', auth.userId).maybeSingle()
  if (error) return apiErrorResponseV1(request, {
    status: 503, code: 'DEPENDENCY_UNAVAILABLE', message: '任务读取失败', retryable: true,
  })
  if (!data || data.type !== 'reasoning.long') return apiErrorResponseV1(request, {
    status: 404, code: 'NOT_FOUND', message: '长期任务不存在', retryable: false,
  })

  if (!isTerminalJobStatus(data.status)) {
    try {
      const result = await new SupabaseJobRepository().cancel({
        jobId,
        principalId: auth.userId,
        reason: 'user deleted long-think task',
      })
      if (!isTerminalJobStatus(result.status)) {
        return Response.json({ deleted: false, status: result.status }, {
          status: 202,
          headers: { 'Cache-Control': 'no-store', 'Retry-After': '1' },
        })
      }
    } catch {
      return apiErrorResponseV1(request, {
        status: 503, code: 'DEPENDENCY_UNAVAILABLE', message: '任务停止失败，暂时无法删除', retryable: true,
        headers: { 'Retry-After': '1' },
      })
    }
  }

  // Job events and ledger rows are intentionally append-only systems of record.
  // User-facing deletion is therefore a visibility tombstone maintained by the
  // Long Think client after this endpoint confirms the task is terminal.
  return Response.json({ deleted: true, jobId, retainedInLedger: true }, {
    headers: { 'Cache-Control': 'no-store' },
  })
}
