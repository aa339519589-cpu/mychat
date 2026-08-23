import { NextRequest } from 'next/server'
import { apiErrorResponseV1 } from '@/lib/api/errors'
import { SupabaseJobRepository } from '@/lib/jobs/supabase-repository'
import {
  chatGptBridgeConfigured,
  verifyChatGptClaimToken,
  verifyChatGptPairToken,
} from '@/lib/chatgpt-bridge/auth'
import { bearerToken } from '@/lib/chatgpt-bridge/queue'

export async function POST(request: NextRequest) {
  if (!chatGptBridgeConfigured()) return apiErrorResponseV1(request, {
    status: 503, code: 'DEPENDENCY_UNAVAILABLE', message: 'ChatGPT 网页桥接未配置', retryable: false,
  })
  const pair = verifyChatGptPairToken(bearerToken(request))
  const claim = verifyChatGptClaimToken(request.headers.get('x-chatgpt-claim')?.trim() ?? '')
  if (!pair || !claim || pair.sub !== claim.sub) return apiErrorResponseV1(request, {
    status: 401, code: 'AUTH_REQUIRED', message: 'ChatGPT 网页桥接租约无效', retryable: false,
  })

  const renewed = await new SupabaseJobRepository().renew({
    jobId: claim.jobId,
    workerId: claim.workerId,
    leaseVersion: claim.leaseVersion,
    leaseSeconds: 900,
  })
  if (renewed.state !== 'renewed') return apiErrorResponseV1(request, {
    status: renewed.state === 'unavailable' ? 503 : 409,
    code: renewed.state === 'unavailable' ? 'DEPENDENCY_UNAVAILABLE' : 'CONFLICT',
    message: renewed.state === 'unavailable' ? '桥接租约续期暂时不可用' : '桥接租约已经失效',
    retryable: true,
  })
  return Response.json({
    renewed: true,
    leaseExpiresAt: renewed.leaseExpiresAt,
    cancelRequested: renewed.cancelRequested,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
