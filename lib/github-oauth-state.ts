import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const PREFIX = 'github-oauth:v1'
const MOBILE_PREFIX = 'github-mobile-oauth:v1'
const NONCE_PATTERN = /^[A-Za-z0-9_-]{32}$/
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MOBILE_STATE_TTL_MS = 10 * 60 * 1000

function stateKey(secret: string): Buffer {
  return createHmac('sha256', secret).update(`${PREFIX}:state-key`).digest()
}

function signature(nonce: string, userId: string, secret: string): string {
  return createHmac('sha256', stateKey(secret))
    .update(JSON.stringify([PREFIX, nonce, userId]))
    .digest('base64url')
}

function mobileSignature(payload: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(`${MOBILE_PREFIX}:state-key`)
    .update(payload)
    .digest('base64url')
}

export function createGitHubOAuthState(userId: string, secret: string): string {
  if (!userId || !secret) throw new Error('GitHub OAuth state 配置无效')
  const nonce = randomBytes(24).toString('base64url')
  return `${nonce}.${signature(nonce, userId, secret)}`
}

export function verifyGitHubOAuthState(
  value: string,
  userId: string,
  secret: string,
): boolean {
  if (!value || !userId || !secret) return false
  const [nonce, supplied, extra] = value.split('.')
  if (extra !== undefined
    || !NONCE_PATTERN.test(nonce ?? '')
    || !SIGNATURE_PATTERN.test(supplied ?? '')) return false
  // Compare the canonical wire encoding, not merely decoded bytes.  Node's
  // base64url decoder accepts non-canonical trailing bits, which would make
  // multiple textual OAuth states validate as the same MAC.
  const expected = Buffer.from(signature(nonce, userId, secret), 'ascii')
  const actual = Buffer.from(supplied, 'ascii')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

export function createGitHubMobileOAuthState(
  userId: string,
  secret: string,
  now = Date.now(),
): string {
  if (!UUID_PATTERN.test(userId) || !secret || !Number.isSafeInteger(now) || now < 0) {
    throw new Error('GitHub mobile OAuth state 配置无效')
  }
  const payload = Buffer.from(JSON.stringify({
    userId: userId.toLowerCase(),
    nonce: randomBytes(24).toString('base64url'),
    expiresAt: now + MOBILE_STATE_TTL_MS,
  }), 'utf8').toString('base64url')
  return `${MOBILE_PREFIX}.${payload}.${mobileSignature(payload, secret)}`
}

export function verifyGitHubMobileOAuthState(
  value: string,
  secret: string,
  now = Date.now(),
): { userId: string } | null {
  const [prefix, payload, supplied, extra] = value.split('.')
  if (extra !== undefined || prefix !== MOBILE_PREFIX || !secret
      || !payload || payload.length > 512 || !/^[A-Za-z0-9_-]+$/.test(payload)
      || !SIGNATURE_PATTERN.test(supplied ?? '') || !Number.isSafeInteger(now)) return null
  const expected = Buffer.from(mobileSignature(payload, secret), 'ascii')
  const actual = Buffer.from(supplied, 'ascii')
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null

  let decoded: unknown
  try {
    const bytes = Buffer.from(payload, 'base64url')
    if (bytes.toString('base64url') !== payload) return null
    decoded = JSON.parse(bytes.toString('utf8'))
  } catch {
    return null
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return null
  const state = decoded as Record<string, unknown>
  if (Object.keys(state).sort().join(',') !== 'expiresAt,nonce,userId'
      || typeof state.userId !== 'string' || !UUID_PATTERN.test(state.userId)
      || typeof state.nonce !== 'string' || !NONCE_PATTERN.test(state.nonce)
      || typeof state.expiresAt !== 'number' || !Number.isSafeInteger(state.expiresAt)
      || state.expiresAt <= now || state.expiresAt > now + MOBILE_STATE_TTL_MS) return null
  return { userId: state.userId.toLowerCase() }
}
