import { NextRequest } from 'next/server'

// 第一步：把用户带去 GitHub 授权页
export async function GET(req: NextRequest) {
  const clientId = process.env.GITHUB_CLIENT_ID
  if (!clientId) return new Response('GitHub OAuth 未配置', { status: 500 })

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? 'https://mychat-nm6x.onrender.com').replace(/\/$/, '')
  const redirectUri = `${appUrl}/api/auth/github/callback`

  // state 用于回调时验证，防止 CSRF
  const state = crypto.randomUUID()

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'repo read:user',
    state,
  })

  const headers = new Headers({
    Location: `https://github.com/login/oauth/authorize?${params}`,
  })
  headers.append('Set-Cookie', `gh_oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`)

  return new Response(null, { status: 302, headers })
}
