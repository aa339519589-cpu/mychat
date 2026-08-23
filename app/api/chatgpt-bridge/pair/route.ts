import { NextRequest } from 'next/server'
import { apiErrorResponseV1 } from '@/lib/api/errors'
import { enforceRequestRateLimit, resolveAuth } from '@/lib/api/guard'
import { chatGptBridgeConfigured, issueChatGptPairToken } from '@/lib/chatgpt-bridge/auth'

export async function POST(request: NextRequest) {
  const auth = await resolveAuth(request)
  if (auth.authUnavailable) return apiErrorResponseV1(request, {
    status: 503,
    code: 'AUTH_DEPENDENCY_UNAVAILABLE',
    message: '认证服务暂时不可用',
    retryable: true,
    headers: { 'Retry-After': '5' },
  })
  if (!auth.supabase || !auth.userId) return apiErrorResponseV1(request, {
    status: 401,
    code: 'AUTH_REQUIRED',
    message: '请先登录',
    retryable: false,
  })
  const rate = await enforceRequestRateLimit(auth, request)
  if (rate.response) return rate.response
  if (!chatGptBridgeConfigured()) return apiErrorResponseV1(request, {
    status: 503,
    code: 'DEPENDENCY_UNAVAILABLE',
    message: 'ChatGPT 网页桥接签名密钥未配置',
    retryable: false,
  })
  const issued = issueChatGptPairToken(auth.userId)
  return Response.json({
    token: issued.token,
    expiresAt: issued.expiresAt,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
