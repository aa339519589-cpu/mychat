import { NextRequest } from 'next/server'
import { apiErrorResponseV1 } from '@/lib/api/errors'
import { readJson, RequestError } from '@/lib/api/request'
import { SupabaseJobRepository } from '@/lib/jobs/supabase-repository'
import {
  chatGptBridgeConfigured,
  verifyChatGptClaimToken,
  verifyChatGptPairToken,
} from '@/lib/chatgpt-bridge/auth'
import { bearerToken } from '@/lib/chatgpt-bridge/queue'

const MAX_TEXT = 1_000_000

function claimHeader(request: Request): string {
  return request.headers.get('x-chatgpt-claim')?.trim() ?? ''
}

function text(value: unknown, maximum: number): string {
  return typeof value === 'string' ? value.slice(0, maximum) : ''
}

export async function POST(request: NextRequest) {
  if (!chatGptBridgeConfigured()) return apiErrorResponseV1(request, {
    status: 503, code: 'DEPENDENCY_UNAVAILABLE', message: 'ChatGPT 网页桥接未配置', retryable: false,
  })
  const pair = verifyChatGptPairToken(bearerToken(request))
  const claim = verifyChatGptClaimToken(claimHeader(request))
  if (!pair || !claim || pair.sub !== claim.sub) return apiErrorResponseV1(request, {
    status: 401, code: 'AUTH_REQUIRED', message: 'ChatGPT 网页桥接租约无效', retryable: false,
  })

  let body: Record<string, unknown>
  try { body = await readJson(request, { maxBytes: 2 * 1024 * 1024 }) }
  catch (error) {
    return apiErrorResponseV1(request, {
      status: error instanceof RequestError ? error.status : 400,
      code: 'INVALID_REQUEST', message: '桥接回传无效', retryable: false,
    })
  }

  const repository = new SupabaseJobRepository()
  const fence = {
    jobId: claim.jobId,
    workerId: claim.workerId,
    leaseVersion: claim.leaseVersion,
  }

  if (body.ok !== true) {
    const message = text(body.error, 2_000) || 'ChatGPT 网页执行失败'
    const retried = await repository.retry({
      ...fence,
      error: {
        code: 'CHATGPT_WEB_TURN_FAILED',
        message,
        retryable: true,
        class: 'provider',
        details: {},
      },
      delaySeconds: 2,
    })
    if (!retried.accepted) return apiErrorResponseV1(request, {
      status: 409,
      code: 'CONFLICT',
      message: `桥接任务无法重试：${retried.reason ?? 'lease lost'}`,
      retryable: retried.reason !== 'attempts_exhausted',
    })
    return Response.json({ accepted: true, retrying: true }, { headers: { 'Cache-Control': 'no-store' } })
  }

  const responseText = text(body.text, MAX_TEXT)
  const reasoning = text(body.reasoning, MAX_TEXT)
  if (!responseText.trim() && !reasoning.trim()) return apiErrorResponseV1(request, {
    status: 400, code: 'INVALID_REQUEST', message: 'ChatGPT 回答为空', retryable: false,
  })

  const finalized = await repository.finalize({
    ...fence,
    status: 'completed',
    result: {
      text: responseText,
      reasoning,
      finishReason: typeof body.finishReason === 'string' ? body.finishReason.slice(0, 64) : 'stop',
      usage: { inputTokens: null, outputTokens: null },
    },
  })
  if (!finalized.accepted && !finalized.replayed) return apiErrorResponseV1(request, {
    status: 409, code: 'CONFLICT', message: '桥接任务租约已经失效', retryable: true,
  })
  return Response.json({ accepted: true, status: finalized.status }, { headers: { 'Cache-Control': 'no-store' } })
}
