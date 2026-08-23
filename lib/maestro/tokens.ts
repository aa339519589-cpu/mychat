import { createHash, createHmac, timingSafeEqual } from "node:crypto"

const TOKEN_PREFIX = "maestro1"
const REPORT_KIND = "widget-report"
const LAUNCH_KIND = "launch"
const TASK_KIND = "task"
const MIN_SECRET_LENGTH = 32
const DEFAULT_TTL_SECONDS = 24 * 60 * 60
const MAX_TTL_SECONDS = 7 * DEFAULT_TTL_SECONDS

type BaseTokenPayload = {
  v: 1
  userId: string
  jobId: string
  exp: number
}

type ReportTokenPayload = BaseTokenPayload & {
  kind: typeof REPORT_KIND
  round: number
  stateHash: string
}

type LaunchTokenPayload = BaseTokenPayload & {
  kind: typeof LAUNCH_KIND
}

type TaskTokenPayload = BaseTokenPayload & {
  kind: typeof TASK_KIND
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

function isBasePayload(row: Record<string, unknown>): boolean {
  return row.v === 1
    && typeof row.userId === "string" && row.userId.length > 0
    && typeof row.jobId === "string" && row.jobId.length > 0
    && Number.isSafeInteger(row.exp) && Number(row.exp) > 0
}

function parseSignedToken(token: string): Record<string, unknown> | null {
  const [prefix, payload, suppliedSignature, extra] = token.trim().split(".")
  if (prefix !== TOKEN_PREFIX || !payload || !suppliedSignature || extra !== undefined) return null
  let expected: string
  try { expected = signature(payload) } catch { return null }
  if (!sameSignature(suppliedSignature, expected)) return null
  let parsed: unknown
  try { parsed = decode(payload) } catch { return null }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const row = parsed as Record<string, unknown>
  if (!isBasePayload(row) || Number(row.exp) < Math.floor(Date.now() / 1000)) return null
  return row
}

function ttlSeconds(value: number | undefined, fallback: number): number {
  return Math.max(60, Math.min(value ?? fallback, MAX_TTL_SECONDS))
}

function signedToken(payload: BaseTokenPayload & { kind: string } & Record<string, unknown>): string {
  const encoded = encode(payload)
  return `${TOKEN_PREFIX}.${encoded}.${signature(encoded)}`
}

export function maestroRunnerConfigured(): boolean {
  return (process.env.MAESTRO_RUNNER_KEY?.trim().length ?? 0) >= MIN_SECRET_LENGTH
}

export function maestroStateHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

export function issueMaestroLaunchToken(options: {
  userId: string
  jobId: string
  ttlSeconds?: number
}): string {
  return signedToken({
    v: 1,
    kind: LAUNCH_KIND,
    userId: options.userId,
    jobId: options.jobId,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds(options.ttlSeconds, 60 * 60),
  })
}

export function verifyMaestroLaunchToken(token: string): LaunchTokenPayload | null {
  const row = parseSignedToken(token)
  if (!row || row.kind !== LAUNCH_KIND) return null
  return row as LaunchTokenPayload
}

export function issueMaestroTaskToken(options: {
  userId: string
  jobId: string
  ttlSeconds?: number
}): string {
  return signedToken({
    v: 1,
    kind: TASK_KIND,
    userId: options.userId,
    jobId: options.jobId,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds(options.ttlSeconds, MAX_TTL_SECONDS),
  })
}

export function verifyMaestroTaskToken(token: string): TaskTokenPayload | null {
  const row = parseSignedToken(token)
  if (!row || row.kind !== TASK_KIND) return null
  return row as TaskTokenPayload
}

export function issueMaestroReportToken(options: {
  userId: string
  jobId: string
  round: number
  stateHash: string
  ttlSeconds?: number
}): string {
  return signedToken({
    v: 1,
    kind: REPORT_KIND,
    userId: options.userId,
    jobId: options.jobId,
    round: options.round,
    stateHash: options.stateHash,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds(options.ttlSeconds, DEFAULT_TTL_SECONDS),
  })
}

export function verifyMaestroReportToken(token: string): ReportTokenPayload | null {
  const row = parseSignedToken(token)
  if (!row || row.kind !== REPORT_KIND) return null
  if (!Number.isSafeInteger(row.round) || Number(row.round) < 0) return null
  if (typeof row.stateHash !== "string" || row.stateHash.length !== 64) return null
  return row as ReportTokenPayload
}
