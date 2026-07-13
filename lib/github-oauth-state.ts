import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const PREFIX = 'github-oauth:v1'
const NONCE_PATTERN = /^[A-Za-z0-9_-]{32}$/
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/

function stateKey(secret: string): Buffer {
  return createHmac('sha256', secret).update(`${PREFIX}:state-key`).digest()
}

function signature(nonce: string, userId: string, secret: string): string {
  return createHmac('sha256', stateKey(secret))
    .update(JSON.stringify([PREFIX, nonce, userId]))
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
