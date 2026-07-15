import { NextRequest } from 'next/server'
import { resolveAuth } from '@/lib/api/guard'
import { appendGitHubOAuthStateCookie, appendLegacyGitHubCookieCleanup } from '@/lib/github-cookies'
import { githubCredentialEncryptionConfigured } from '@/lib/github-credential'
import { createGitHubOAuthState } from '@/lib/github-oauth-state'
import { isAdminConfigured } from '@/lib/supabase/admin'

// 第一步：把用户带去 GitHub 授权页
export async function GET(req: NextRequest) {
  const clientId = process.env.GITHUB_CLIENT_ID
  const clientSecret = process.env.GITHUB_CLIENT_SECRET
  if (!clientId || !clientSecret || !githubCredentialEncryptionConfigured() || !isAdminConfigured()) {
    return new Response('GitHub OAuth 暂不可用', { status: 503 })
  }
  const auth = await resolveAuth()
  if (!auth.userId) return new Response('请先登录 MyChat', { status: 401 })

  const origin = process.env.AGENT_PUBLIC_URL?.trim().replace(/\/$/, '') || req.nextUrl.origin
  const redirectUri = `${origin}/api/auth/github/callback`

  // state 同时绑定当前 Supabase user，避免 OAuth 期间切换账号后串绑。
  const state = createGitHubOAuthState(auth.userId, clientSecret)

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'repo read:user',
    state,
  })

  const headers = new Headers({
    Location: `https://github.com/login/oauth/authorize?${params}`,
    'Cache-Control': 'no-store',
  })
  appendGitHubOAuthStateCookie(headers, state)
  appendLegacyGitHubCookieCleanup(headers)

  return new Response(null, { status: 302, headers })
}
