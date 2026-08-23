import { NextRequest } from 'next/server'
import { apiErrorResponseV1 } from '@/lib/api/errors'
import { enforceRequestRateLimit, resolveAuth } from '@/lib/api/guard'
import { readJson, requestId, RequestError } from '@/lib/api/request'
import { expensiveWriteMaintenanceResponse } from '@/lib/api/maintenance'
import { SupabaseJobRepository } from '@/lib/jobs/supabase-repository'
import { sha256JobValue } from '@/lib/jobs/canonical'
import type { JsonObject, JobAuthClass } from '@/lib/jobs/contracts'

const MAX_PROBLEM_CHARS = 1_000_000

function integer(value: unknown, fallback: number, minimum: number, maximum: number): number | null {
  if (value === undefined) return fallback
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum
    ? Number(value)
    : null
}

function parseCreateInput(body: Record<string, unknown>): JsonObject | null {
  const problem = typeof body.problem === 'string' ? body.problem.trim() : ''
  const maxTokens = integer(body.maxTokens, 32_768, 512, 262_144)
  const minRounds = integer(body.minRounds, 4, 1, 100_000)
  const verifyEvery = integer(body.verifyEvery, 6, 1, 10_000)
  if (!problem || problem.length > MAX_PROBLEM_CHARS || maxTokens === null || minRounds === null || verifyEvery === null) return null
  return { problem, maxTokens, minRounds, verifyEvery }
}

async function enqueue(input: JsonObject, principalId: string, authClass: JobAuthClass) {
  const jobId = crypto.randomUUID()
  return new SupabaseJobRepository().enqueue({
    jobId,
    type: 'reasoning.chatgpt-long',
    queue: 'longthink',
    principal: { id: principalId, authClass },
    subject: { feature: 'chatgpt-subscription-long-think' },
    idempotencyKey: `chatgpt-long:${jobId}`,
    inputHash: sha256JobValue(input),
    input,
    maxAttempts: 100,
    priority: -10,
  })
}

export async function POST(request: NextRequest) {
  const maintenance = expensiveWriteMaintenanceResponse(request)
  if (maintenance) return maintenance
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

  let body: Record<string, unknown>
  try { body = await readJson(request, { maxBytes: 2 * 1024 * 1024 }) }
  catch (error) {
    return apiErrorResponseV1(request, {
      status: error instanceof RequestError ? error.status : 400,
      code: 'INVALID_REQUEST', message: error instanceof Error ? error.message : '请求体无效', retryable: false,
    })
  }
  const input = parseCreateInput(body)
  if (!input) return apiErrorResponseV1(request, {
    status: 400, code: 'INVALID_REQUEST', message: 'ChatGPT 长任务参数无效', retryable: false,
  })

  try {
    const enqueued = await enqueue(input, auth.userId, auth.isAnonymous ? 'anonymous' : 'registered')
    return Response.json({
      jobId: enqueued.job.id,
      status: enqueued.job.status,
      created: enqueued.created,
      statusUrl: `/api/v1/jobs/${enqueued.job.id}`,
      cancelUrl: `/api/v1/jobs/${enqueued.job.id}/cancel`,
    }, {
      status: 202,
      headers: { 'Cache-Control': 'no-store', Location: `/api/v1/jobs/${enqueued.job.id}`, 'X-Request-Id': requestId(request) },
    })
  } catch (error) {
    return apiErrorResponseV1(request, {
      status: 503, code: 'DEPENDENCY_UNAVAILABLE',
      message: error instanceof Error ? error.message : 'ChatGPT 长任务入队失败', retryable: true,
      headers: { 'Retry-After': '2' },
    })
  }
}

export async function GET(request: NextRequest) {
  const auth = await resolveAuth(request)
  if (!auth.supabase || !auth.userId) return apiErrorResponseV1(request, {
    status: auth.authUnavailable ? 503 : 401,
    code: auth.authUnavailable ? 'AUTH_DEPENDENCY_UNAVAILABLE' : 'AUTH_REQUIRED',
    message: auth.authUnavailable ? '认证服务暂时不可用' : '请先登录',
    retryable: auth.authUnavailable === true,
  })
  const { data, error } = await auth.supabase.from('jobs')
    .select('id,status,progress,result,error_class,error_code,created_at,updated_at,started_at,terminal_at')
    .eq('principal_id', auth.userId).eq('type', 'reasoning.chatgpt-long')
    .order('created_at', { ascending: false }).limit(50)
  if (error) return apiErrorResponseV1(request, {
    status: 503, code: 'DEPENDENCY_UNAVAILABLE', message: 'ChatGPT 长任务列表暂时不可用', retryable: true,
  })
  return Response.json({ jobs: data ?? [] }, { headers: { 'Cache-Control': 'no-store' } })
}
