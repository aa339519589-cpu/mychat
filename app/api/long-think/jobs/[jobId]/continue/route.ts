import { NextRequest } from 'next/server'
import { apiErrorResponseV1 } from '@/lib/api/errors'
import { enforceRequestRateLimit, resolveAuth } from '@/lib/api/guard'
import { expensiveWriteMaintenanceResponse } from '@/lib/api/maintenance'
import { readJson, requestId, RequestError } from '@/lib/api/request'
import { sha256JobValue } from '@/lib/jobs/canonical'
import { isJsonValue, type JsonObject, type JobAuthClass } from '@/lib/jobs/contracts'
import { SupabaseJobRepository } from '@/lib/jobs/supabase-repository'
import { isUuid } from '@/lib/validation'

const MAX_INSTRUCTION_CHARS = 200_000

type SourceLongThinkInput = {
  endpointId: string
  problem: string
  maxTokens?: unknown
  verifyEvery?: unknown
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function jsonObject(value: unknown): JsonObject | null {
  return isJsonValue(value) && value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject : null
}

function integer(value: unknown, fallback: number, minimum: number, maximum: number): number | null {
  if (value === undefined) return fallback
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum
    ? Number(value)
    : null
}

function checkpointData(value: unknown): JsonObject | null {
  const row = object(value)
  return row ? jsonObject(row.data) : null
}

function resultCheckpoint(value: unknown): JsonObject | null {
  const row = object(value)
  return row ? jsonObject(row.continuationCheckpoint) : null
}

function sourceInput(value: unknown): SourceLongThinkInput | null {
  const row = object(value)
  if (!row || typeof row.endpointId !== 'string' || typeof row.problem !== 'string') return null
  return {
    endpointId: row.endpointId,
    problem: row.problem,
    maxTokens: row.maxTokens,
    verifyEvery: row.verifyEvery,
  }
}

async function enqueue(input: JsonObject, principalId: string, authClass: JobAuthClass, sourceJobId: string) {
  const jobId = crypto.randomUUID()
  return new SupabaseJobRepository().enqueue({
    jobId,
    type: 'reasoning.long',
    queue: 'longthink',
    principal: { id: principalId, authClass },
    subject: { feature: 'long-think', endpointId: String(input.endpointId), continuedFrom: sourceJobId },
    idempotencyKey: `longthink:${jobId}`,
    inputHash: sha256JobValue(input),
    input,
    maxAttempts: 100,
    priority: -10,
  })
}

export async function POST(request: NextRequest, context: { params: Promise<{ jobId: string }> }) {
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

  const { jobId: sourceJobId } = await context.params
  if (!isUuid(sourceJobId)) return apiErrorResponseV1(request, {
    status: 400, code: 'INVALID_REQUEST', message: 'jobId 无效', retryable: false,
  })

  let body: Record<string, unknown>
  try { body = await readJson(request, { maxBytes: 512 * 1024 }) }
  catch (error) {
    return apiErrorResponseV1(request, {
      status: error instanceof RequestError ? error.status : 400,
      code: 'INVALID_REQUEST', message: error instanceof Error ? error.message : '请求体无效', retryable: false,
    })
  }
  const instruction = typeof body.instruction === 'string' ? body.instruction.trim() : ''
  if (!instruction || instruction.length > MAX_INSTRUCTION_CHARS) return apiErrorResponseV1(request, {
    status: 400, code: 'INVALID_REQUEST', message: '请输入继续要求', retryable: false,
  })

  const { data, error } = await auth.supabase.from('jobs')
    .select('id,type,status,input,checkpoint,result')
    .eq('id', sourceJobId).eq('principal_id', auth.userId).maybeSingle()
  if (error) return apiErrorResponseV1(request, {
    status: 503, code: 'DEPENDENCY_UNAVAILABLE', message: '旧任务读取失败', retryable: true,
  })
  const row = object(data)
  if (!row || row.type !== 'reasoning.long') return apiErrorResponseV1(request, {
    status: 404, code: 'NOT_FOUND', message: '长期任务不存在', retryable: false,
  })

  const oldInput = sourceInput(row.input)
  const seed = checkpointData(row.checkpoint) ?? resultCheckpoint(row.result)
  if (!oldInput || !seed) return apiErrorResponseV1(request, {
    status: 409, code: 'CONFLICT', message: '这个任务还没有可续接的 checkpoint', retryable: false,
  })

  const maxTokens = integer(body.maxTokens, Number(oldInput.maxTokens) || 32_768, 512, 262_144)
  const minRounds = integer(body.minRounds, 1, 1, 100_000)
  const verifyEvery = integer(body.verifyEvery, Number(oldInput.verifyEvery) || 6, 1, 10_000)
  if (maxTokens === null || minRounds === null || verifyEvery === null) return apiErrorResponseV1(request, {
    status: 400, code: 'INVALID_REQUEST', message: '继续任务参数无效', retryable: false,
  })

  const nextInput: JsonObject = {
    endpointId: oldInput.endpointId,
    problem: `${oldInput.problem.trim()}\n\n【用户继续要求】\n${instruction}`,
    maxTokens,
    minRounds,
    verifyEvery,
    seedCheckpoint: seed,
    continuedFrom: sourceJobId,
  }

  try {
    const enqueued = await enqueue(nextInput, auth.userId, auth.isAnonymous ? 'anonymous' : 'registered', sourceJobId)
    return Response.json({ jobId: enqueued.job.id, status: enqueued.job.status }, {
      status: 202,
      headers: {
        'Cache-Control': 'no-store',
        Location: `/api/v1/jobs/${enqueued.job.id}`,
        'X-Request-Id': requestId(request),
      },
    })
  } catch (cause) {
    return apiErrorResponseV1(request, {
      status: 503, code: 'DEPENDENCY_UNAVAILABLE',
      message: cause instanceof Error ? cause.message : '继续任务入队失败', retryable: true,
      headers: { 'Retry-After': '2' },
    })
  }
}
