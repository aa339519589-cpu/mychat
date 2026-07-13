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
import { verifyGitHubOAuthState } from '@/lib/github-oauth-state'
import { revokeGitHubOAuthToken } from '@/lib/github-token-revocation'
import { isAdminConfigured } from '@/lib/supabase/admin'

type UnknownRecord = Record<string, unknown>

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null
}

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

function parseExpiry(value: unknown): Date | null | undefined {
  if (value === undefined || value === null) return null
  const seconds = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : Number.NaN
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 366 * 24 * 60 * 60) {
    return undefined
  }
  const expiresAt = new Date(Date.now() + seconds * 1000)
  return Number.isFinite(expiresAt.getTime()) ? expiresAt : undefined
}

function parseScopes(value: unknown): string[] | undefined {
  if (value === undefined || value === null || value === '') return []
  if (typeof value !== 'string') return undefined
  const scopes = [...new Set(value.split(/[,\s]+/).map(scope => scope.trim()).filter(Boolean))]
  return scopes.length <= 64 && scopes.every(scope => /^[A-Za-z0-9:_-]{1,100}$/.test(scope))
    ? scopes
    : undefined
}

// GitHub returns a code once; the resulting bearer token is encrypted into the
// service-only connection table and only an opaque connection id reaches the browser.
export async function GET(req: NextRequest) {
  const origin = process.env.AGENT_PUBLIC_URL?.trim().replace(/\/$/, '') || req.nextUrl.origin
  const home = `${origin}/`
  const clientId = process.env.GITHUB_CLIENT_ID?.trim()
  const clientSecret = process.env.GITHUB_CLIENT_SECRET?.trim()
  if (!clientId
    || !clientSecret
    || !githubCredentialEncryptionConfigured()
    || !isAdminConfigured()) return redirect(home, 'error')

  const auth = await resolveAuth()
  if (!auth.userId) return redirect(home, 'error')

  const code = req.nextUrl.searchParams.get('code')
  const state = req.nextUrl.searchParams.get('state') ?? ''
  const savedState = req.cookies.get(GITHUB_OAUTH_STATE_COOKIE)?.value ?? ''
  if (!code
    || state !== savedState
    || !verifyGitHubOAuthState(state, auth.userId, clientSecret)) {
    return redirect(home, 'error')
  }

  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null)
  if (!tokenRes?.ok) return redirect(home, 'error')

  const tokenData = record(await tokenRes.json().catch(() => null))
  const accessToken = typeof tokenData?.access_token === 'string'
    ? tokenData.access_token
    : ''
  const tokenType = tokenData?.token_type
  const expiresAt = parseExpiry(tokenData?.expires_in)
  const scopes = parseScopes(tokenData?.scope)
  if (!accessToken
    || accessToken.length > 16_384
    || (tokenType !== undefined && tokenType !== 'bearer')
    || expiresAt === undefined
    || scopes === undefined) {
    if (accessToken) {
      await revokeGitHubOAuthToken(accessToken, { clientId, clientSecret }).catch(() => false)
    }
    return redirect(home, 'error')
  }

  const userRes = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'mychat-app',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null)
  const userData = userRes?.ok ? record(await userRes.json().catch(() => null)) : null
  const login = typeof userData?.login === 'string' ? userData.login : ''
  const githubUserId = typeof userData?.id === 'number' ? userData.id : Number.NaN
  if (!login || !Number.isSafeInteger(githubUserId) || githubUserId <= 0) {
    await revokeGitHubOAuthToken(accessToken, { clientId, clientSecret }).catch(() => false)
    return redirect(home, 'error')
  }

  try {
    const connection = await persistGitHubConnection({
      userId: auth.userId,
      githubUserId,
      login,
      token: accessToken,
      scopes,
      expiresAt,
      requestId: requestId(req),
    })
    const maxAgeSeconds = expiresAt
      ? Math.min(30 * 24 * 60 * 60, Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000)))
      : 30 * 24 * 60 * 60
    return redirect(home, 'connected', { id: connection.connectionId, maxAgeSeconds })
  } catch {
    // Do not leave an active orphan token if encrypted persistence fails.
    await revokeGitHubOAuthToken(accessToken, { clientId, clientSecret }).catch(() => false)
    return redirect(home, 'error')
  }
}
