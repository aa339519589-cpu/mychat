import { NextRequest } from 'next/server'
import { resolveAuth } from '@/lib/api/guard'
import { requestId } from '@/lib/api/request'
import { persistGitHubConnection } from '@/lib/github-connection'
import {
  appendGitHubConnectionCookie,
  appendGitHubOAuthStateCleanup,
  appendLegacyGitHubCookieCleanup,
  GITHUB_OAUTH_STATE_COOKIE,
} from '@/lib/github-cookies'
import { githubCredentialEncryptionConfigured } from '@/lib/github-credential'
import {
  githubConnectionCookieMaxAge,
  parseGitHubOAuthCode,
  parseGitHubOAuthToken,
  parseGitHubUser,
  resolveGitHubOAuthBaseUrl,
  type GitHubOAuthCredential,
  type GitHubOAuthTokenResult,
} from '@/lib/github-oauth-flow'
import { verifyGitHubOAuthState } from '@/lib/github-oauth-state'
import { revokeGitHubOAuthToken } from '@/lib/github-token-revocation'
import { isAdminConfigured } from '@/lib/supabase/admin'

type OAuthConfig = { clientId: string; clientSecret: string }

function redirect(home: string, outcome: 'connected' | 'error', connection?: {
  id: string
  maxAgeSeconds: number
}): Response {
  const headers = new Headers({
    Location: `${home}?github=${outcome}`,
    'Cache-Control': 'no-store',
  })
  appendGitHubOAuthStateCleanup(headers)
  appendLegacyGitHubCookieCleanup(headers)
  if (connection) appendGitHubConnectionCookie(headers, connection.id, connection.maxAgeSeconds)
  return new Response(null, { status: 302, headers })
}

function callbackHome(request: NextRequest): string | null {
  try {
    return `${resolveGitHubOAuthBaseUrl(
      process.env.AGENT_PUBLIC_URL,
      request.nextUrl.origin,
    )}/`
  } catch {
    return null
  }
}

function oauthConfig(): OAuthConfig | null {
  const clientId = process.env.GITHUB_CLIENT_ID?.trim()
  const clientSecret = process.env.GITHUB_CLIENT_SECRET?.trim()
  if (!clientId || !clientSecret || !githubCredentialEncryptionConfigured() || !isAdminConfigured()) return null
  return { clientId, clientSecret }
}

function callbackCode(request: NextRequest, userId: string, clientSecret: string): string | null {
  const code = parseGitHubOAuthCode(request.nextUrl.searchParams.get('code'))
  const state = request.nextUrl.searchParams.get('state') ?? ''
  const savedState = request.cookies.get(GITHUB_OAUTH_STATE_COOKIE)?.value ?? ''
  return code && state === savedState && verifyGitHubOAuthState(state, userId, clientSecret)
    ? code
    : null
}

async function exchangeCode(code: string, config: OAuthConfig): Promise<GitHubOAuthTokenResult> {
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, code }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null)
  if (!response?.ok) return { ok: false, accessToken: '' }
  return parseGitHubOAuthToken(await response.json().catch(() => null))
}

async function githubUser(accessToken: string) {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'mychat-app',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null)
  return response?.ok ? parseGitHubUser(await response.json().catch(() => null)) : null
}

async function revoke(accessToken: string, config: OAuthConfig): Promise<void> {
  if (!accessToken) return
  await revokeGitHubOAuthToken(accessToken, config).catch(() => false)
}

async function persistConnection(
  request: NextRequest,
  userId: string,
  credential: GitHubOAuthCredential,
  user: { login: string; githubUserId: number },
) {
  return persistGitHubConnection({
    userId,
    githubUserId: user.githubUserId,
    login: user.login,
    token: credential.accessToken,
    scopes: credential.scopes,
    expiresAt: credential.expiresAt,
    requestId: requestId(request),
  })
}

// GitHub returns a code once; the bearer token is encrypted into a service-only
// connection row and only an opaque connection id reaches the browser.
export async function GET(request: NextRequest): Promise<Response> {
  const home = callbackHome(request)
  if (!home) return new Response('GitHub OAuth 配置无效', { status: 503 })
  const config = oauthConfig()
  if (!config) return redirect(home, 'error')
  const auth = await resolveAuth()
  if (!auth.userId) return redirect(home, 'error')
  const code = callbackCode(request, auth.userId, config.clientSecret)
  if (!code) return redirect(home, 'error')

  const credential = await exchangeCode(code, config)
  if (!credential.ok) {
    await revoke(credential.accessToken, config)
    return redirect(home, 'error')
  }
  const user = await githubUser(credential.accessToken)
  if (!user) {
    await revoke(credential.accessToken, config)
    return redirect(home, 'error')
  }
  try {
    const connection = await persistConnection(request, auth.userId, credential, user)
    return redirect(home, 'connected', {
      id: connection.connectionId,
      maxAgeSeconds: githubConnectionCookieMaxAge(credential.expiresAt),
    })
  } catch {
    await revoke(credential.accessToken, config)
    return redirect(home, 'error')
  }
}
