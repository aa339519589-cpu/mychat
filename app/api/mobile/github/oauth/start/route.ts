import { type NextRequest } from 'next/server'
import { apiErrorResponseV1 } from '@/lib/api/errors'
import { enforceRequestRateLimit, resolveAuth } from '@/lib/api/guard'
import { githubCredentialEncryptionConfigured } from '@/lib/github-credential'
import { resolveGitHubOAuthBaseUrl } from '@/lib/github-oauth-flow'
import { createGitHubMobileOAuthState } from '@/lib/github-oauth-state'
import { isAdminConfigured } from '@/lib/supabase/admin'

export async function POST(request: NextRequest): Promise<Response> {
  const auth = await resolveAuth(request)
  const rate = await enforceRequestRateLimit(auth, request)
  if (rate.response) return rate.response
  if (!auth.userId) return apiErrorResponseV1(request, {
    status: auth.authUnavailable ? 503 : 401,
    code: auth.authUnavailable ? 'AUTH_DEPENDENCY_UNAVAILABLE' : 'AUTH_REQUIRED',
    message: auth.authUnavailable ? '认证服务暂时不可用' : '请先登录 MyChat',
    retryable: auth.authUnavailable === true,
  })

  const clientId = process.env.GITHUB_CLIENT_ID?.trim()
  const clientSecret = process.env.GITHUB_CLIENT_SECRET?.trim()
  if (!clientId || !clientSecret || !githubCredentialEncryptionConfigured() || !isAdminConfigured()) {
    return apiErrorResponseV1(request, {
      status: 503,
      code: 'DEPENDENCY_UNAVAILABLE',
      message: 'GitHub OAuth 暂不可用',
      retryable: true,
    })
  }

  let origin: string
  try {
    origin = resolveGitHubOAuthBaseUrl(process.env.AGENT_PUBLIC_URL, request.nextUrl.origin)
  } catch {
    return apiErrorResponseV1(request, {
      status: 503,
      code: 'DEPENDENCY_UNAVAILABLE',
      message: 'GitHub OAuth 配置无效',
      retryable: false,
    })
  }
  const state = createGitHubMobileOAuthState(auth.userId, clientSecret)
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${origin}/api/auth/github/callback`,
    scope: 'repo read:user',
    state,
  })
  return Response.json({
    schemaVersion: 1,
    authorizationUrl: `https://github.com/login/oauth/authorize?${params}`,
    callbackScheme: 'mychat',
  }, { headers: { 'Cache-Control': 'no-store' } })
}
