export const GITHUB_CONNECTION_COOKIE = '__Host-mychat_github_connection'
export const GITHUB_OAUTH_STATE_COOKIE = '__Host-mychat_github_oauth_state'

const SECURE_COOKIE = 'HttpOnly; Secure; SameSite=Lax; Path=/'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const OAUTH_STATE_PATTERN = /^[A-Za-z0-9_-]{32}\.[A-Za-z0-9_-]{43}$/
const LEGACY_COOKIE_NAMES = [
  'gh_access_token',
  'gh_login',
  'gh_user_id',
  'gh_connection_id',
  'gh_oauth_state',
] as const

export function appendLegacyGitHubCookieCleanup(headers: Headers): void {
  for (const name of LEGACY_COOKIE_NAMES) {
    headers.append('Set-Cookie', `${name}=; ${SECURE_COOKIE}; Max-Age=0`)
  }
}

export function appendGitHubConnectionCookie(
  headers: Headers,
  connectionId: string,
  maxAgeSeconds = 30 * 24 * 60 * 60,
): void {
  if (!UUID_PATTERN.test(connectionId) || !Number.isFinite(maxAgeSeconds)) {
    throw new Error('GitHub connection cookie 参数无效')
  }
  headers.append(
    'Set-Cookie',
    `${GITHUB_CONNECTION_COOKIE}=${connectionId}; ${SECURE_COOKIE}; Max-Age=${Math.max(1, Math.floor(maxAgeSeconds))}`,
  )
}

export function appendGitHubOAuthStateCookie(headers: Headers, state: string): void {
  if (!OAUTH_STATE_PATTERN.test(state)) throw new Error('GitHub OAuth state cookie 参数无效')
  headers.append(
    'Set-Cookie',
    `${GITHUB_OAUTH_STATE_COOKIE}=${state}; ${SECURE_COOKIE}; Max-Age=600`,
  )
}

export function appendGitHubOAuthStateCleanup(headers: Headers): void {
  headers.append('Set-Cookie', `${GITHUB_OAUTH_STATE_COOKIE}=; ${SECURE_COOKIE}; Max-Age=0`)
}

export function appendGitHubCookieCleanup(headers: Headers): void {
  headers.append('Set-Cookie', `${GITHUB_CONNECTION_COOKIE}=; ${SECURE_COOKIE}; Max-Age=0`)
  appendGitHubOAuthStateCleanup(headers)
  appendLegacyGitHubCookieCleanup(headers)
}
