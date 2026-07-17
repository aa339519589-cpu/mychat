import { isRecord } from './unknown-value'

const MAX_TOKEN_LENGTH = 16_384
const MAX_EXPIRY_SECONDS = 366 * 24 * 60 * 60
const MAX_CONNECTION_AGE_SECONDS = 30 * 24 * 60 * 60
const OAUTH_CODE_PATTERN = /^[A-Za-z0-9_-]{1,1024}$/
const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/

export type GitHubOAuthCredential = {
  accessToken: string
  expiresAt: Date | null
  scopes: string[]
}

export type GitHubOAuthTokenResult =
  | ({ ok: true } & GitHubOAuthCredential)
  | { ok: false; accessToken: string }

export function resolveGitHubOAuthBaseUrl(
  configured: string | undefined,
  requestOrigin: string,
  production = process.env.NODE_ENV === 'production',
): string {
  const raw = configured?.trim() || requestOrigin
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new TypeError('GitHub OAuth public URL is invalid')
  }
  const schemeAllowed = url.protocol === 'https:' || (!production && url.protocol === 'http:')
  if (!schemeAllowed || url.username || url.password || url.search || url.hash) {
    throw new TypeError('GitHub OAuth public URL is unsafe')
  }
  return url.href.replace(/\/$/, '')
}

export function parseGitHubOAuthCode(value: string | null): string | null {
  return value && OAUTH_CODE_PATTERN.test(value) ? value : null
}

function parseExpiry(value: unknown, now: number): Date | null | undefined {
  if (value === undefined || value === null) return null
  const seconds = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : Number.NaN
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > MAX_EXPIRY_SECONDS) return undefined
  const expiresAt = new Date(now + seconds * 1000)
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

function tokenToRevoke(value: unknown): string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TOKEN_LENGTH ? value : ''
}

export function parseGitHubOAuthToken(value: unknown, now = Date.now()): GitHubOAuthTokenResult {
  const source = isRecord(value) ? value : null
  const accessToken = tokenToRevoke(source?.access_token)
  const expiresAt = parseExpiry(source?.expires_in, now)
  const scopes = parseScopes(source?.scope)
  const tokenType = source?.token_type
  const tokenSafe = /^[\x21-\x7e]+$/.test(accessToken)
  if (!source || !tokenSafe || (tokenType !== undefined && tokenType !== 'bearer')
    || expiresAt === undefined || scopes === undefined) {
    return { ok: false, accessToken }
  }
  return { ok: true, accessToken, expiresAt, scopes }
}

export function parseGitHubUser(value: unknown): { login: string; githubUserId: number } | null {
  const source = isRecord(value) ? value : null
  const login = source?.login
  const githubUserId = source?.id
  if (typeof login !== 'string' || !GITHUB_LOGIN_PATTERN.test(login)
    || !Number.isSafeInteger(githubUserId) || Number(githubUserId) <= 0) return null
  return { login, githubUserId: Number(githubUserId) }
}

export function githubConnectionCookieMaxAge(expiresAt: Date | null, now = Date.now()): number {
  if (!expiresAt) return MAX_CONNECTION_AGE_SECONDS
  const remaining = Math.floor((expiresAt.getTime() - now) / 1000)
  return Math.min(MAX_CONNECTION_AGE_SECONDS, Math.max(1, remaining))
}
