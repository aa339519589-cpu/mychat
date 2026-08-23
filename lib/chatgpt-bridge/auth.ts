import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

const VERSION = 1
const PAIR_TTL_SECONDS = 90 * 24 * 60 * 60
const CLAIM_TTL_SECONDS = 20 * 60

type PairPayload = {
  v: 1
  kind: 'pair'
  sub: string
  exp: number
}

type ClaimPayload = {
  v: 1
  kind: 'claim'
  sub: string
  jobId: string
  workerId: string
  leaseVersion: number
  exp: number
}

function configuredSecret(): string {
  return process.env.AGENT_CREDENTIAL_KEY?.trim() ?? ''
}

function signingKey(): Buffer {
  const secret = configuredSecret()
  if (secret.length < 32) throw new Error('ChatGPT bridge signing is not configured')
  return createHash('sha256').update(`mychat:chatgpt-bridge:v1:${secret}`).digest()
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function signature(payload: string): Buffer {
  return createHmac('sha256', signingKey()).update(payload).digest()
}

function sign(value: PairPayload | ClaimPayload): string {
  const payload = encode(value)
  return `${payload}.${signature(payload).toString('base64url')}`
}

function decode(token: string): Record<string, unknown> | null {
  const [payload, mac, extra] = token.split('.')
  if (!payload || !mac || extra !== undefined) return null
  let actual: Buffer
  try { actual = Buffer.from(mac, 'base64url') } catch { return null }
  const expected = signature(payload)
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch { return null }
}

function validExpiry(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > Math.floor(Date.now() / 1000)
}

export function chatGptBridgeConfigured(): boolean {
  return configuredSecret().length >= 32
}

export function issueChatGptPairToken(principalId: string): { token: string; expiresAt: string } {
  const exp = Math.floor(Date.now() / 1000) + PAIR_TTL_SECONDS
  return {
    token: sign({ v: VERSION, kind: 'pair', sub: principalId, exp }),
    expiresAt: new Date(exp * 1000).toISOString(),
  }
}

export function verifyChatGptPairToken(token: string): PairPayload | null {
  const value = decode(token)
  if (!value || value.v !== VERSION || value.kind !== 'pair' || typeof value.sub !== 'string' || !validExpiry(value.exp)) return null
  return { v: VERSION, kind: 'pair', sub: value.sub, exp: Number(value.exp) }
}

export function issueChatGptClaimToken(input: {
  principalId: string
  jobId: string
  workerId: string
  leaseVersion: number
}): string {
  return sign({
    v: VERSION,
    kind: 'claim',
    sub: input.principalId,
    jobId: input.jobId,
    workerId: input.workerId,
    leaseVersion: input.leaseVersion,
    exp: Math.floor(Date.now() / 1000) + CLAIM_TTL_SECONDS,
  })
}

export function verifyChatGptClaimToken(token: string): ClaimPayload | null {
  const value = decode(token)
  if (!value || value.v !== VERSION || value.kind !== 'claim'
    || typeof value.sub !== 'string' || typeof value.jobId !== 'string'
    || typeof value.workerId !== 'string' || !Number.isSafeInteger(value.leaseVersion)
    || Number(value.leaseVersion) < 1 || !validExpiry(value.exp)) return null
  return {
    v: VERSION,
    kind: 'claim',
    sub: value.sub,
    jobId: value.jobId,
    workerId: value.workerId,
    leaseVersion: Number(value.leaseVersion),
    exp: Number(value.exp),
  }
}
