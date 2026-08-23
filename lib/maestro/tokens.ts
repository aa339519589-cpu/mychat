import { createHash, createHmac, timingSafeEqual } from "node:crypto"

const TOKEN_PREFIX = "maestro1"
const TOKEN_KIND = "widget-report"
const MIN_SECRET_LENGTH = 32
const DEFAULT_TTL_SECONDS = 24 * 60 * 60

type ReportTokenPayload = {
  v: 1
  kind: typeof TOKEN_KIND
  userId: string
  jobId: string
  round: number
  stateHash: string
  exp: number
}

function secret(): string {
  const value = process.env.MAESTRO_RUNNER_KEY?.trim() ?? ""
  if (value.length < MIN_SECRET_LENGTH) throw new Error("MAESTRO_RUNNER_KEY is not configured")
  return value
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url")
}

function decode(value: string): unknown {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"))
}

function signature(payload: string): string {
  return createHmac("sha256", secret()).update(`${TOKEN_PREFIX}.${payload}`).digest("base64url")
}

function sameSignature(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function isPayload(value: unknown): value is ReportTokenPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return row.v === 1
    && row.kind === TOKEN_KIND
    && typeof row.userId === "string" && row.userId.length > 0
    && typeof row.jobId === "string" && row.jobId.length > 0
    && Number.isSafeInteger(row.round) && Number(row.round) >= 0
    && typeof row.stateHash === "string" && row.stateHash.length === 64
    && Number.isSafeInteger(row.exp) && Number(row.exp) > 0
}

export function maestroRunnerConfigured(): boolean {
  return (process.env.MAESTRO_RUNNER_KEY?.trim().length ?? 0) >= MIN_SECRET_LENGTH
}

export function maestroStateHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

export function issueMaestroReportToken(options: {
  userId: string
  jobId: string
  round: number
  stateHash: string
  ttlSeconds?: number
}): string {
  const ttl = Math.max(60, Math.min(options.ttlSeconds ?? DEFAULT_TTL_SECONDS, 7 * DEFAULT_TTL_SECONDS))
  const payload = encode({
    v: 1,
    kind: TOKEN_KIND,
    userId: options.userId,
    jobId: options.jobId,
    round: options.round,
    stateHash: options.stateHash,
    exp: Math.floor(Date.now() / 1000) + ttl,
  } satisfies ReportTokenPayload)
  return `${TOKEN_PREFIX}.${payload}.${signature(payload)}`
}

export function verifyMaestroReportToken(token: string): ReportTokenPayload | null {
  const [prefix, payload, suppliedSignature, extra] = token.trim().split(".")
  if (prefix !== TOKEN_PREFIX || !payload || !suppliedSignature || extra !== undefined) return null
  let expected: string
  try { expected = signature(payload) } catch { return null }
  if (!sameSignature(suppliedSignature, expected)) return null
  let parsed: unknown
  try { parsed = decode(payload) } catch { return null }
  if (!isPayload(parsed) || parsed.exp < Math.floor(Date.now() / 1000)) return null
  return parsed
}
