export type Endpoint = {
  id: string
  name: string
  baseUrl: string
  model: string
  outputKind: string
  needsReconnect?: boolean
}

export type JobSnapshot = {
  id: string
  status: string
  progress: Record<string, unknown>
  result: unknown
  errorClass: string | null
  errorCode: string | null
  createdAt: string
  updatedAt: string
  startedAt: string | null
  terminalAt: string | null
}

export type ListedJob = {
  id: string
  status: string
  progress: Record<string, unknown> | null
  result: unknown
  error_code: string | null
  created_at: string
  updated_at: string
  started_at: string | null
  terminal_at: string | null
}

export type LongThinkContinuation = {
  endpointId: string
  seedCheckpoint: Record<string, unknown>
}

export const LONG_THINK_ACTIVE = new Set(["queued", "leased", "running", "awaiting_input", "cancelling"])
export const LONG_THINK_STORAGE_KEY = "mychat.longThink.activeJob"

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

function messageOf(value: unknown, fallback: string): string {
  const row = record(value)
  if (!row) return fallback
  if (typeof row.error === "string") return row.error
  const nestedError = record(row.error)
  if (nestedError && typeof nestedError.message === "string") return nestedError.message
  if (typeof row.message === "string") return row.message
  return fallback
}

export async function longThinkJsonRequest(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, { cache: "no-store", ...init })
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(messageOf(body, `请求失败（${response.status}）`))
  return body
}

export function longThinkInteger(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0
}

export function longThinkNullableInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null
}

export function longThinkResultAnswer(value: unknown): string {
  const row = record(value)
  return row && typeof row.finalAnswer === "string" ? row.finalAnswer : ""
}

export function longThinkContinuation(value: unknown): LongThinkContinuation | null {
  const row = record(value)
  if (!row || typeof row.endpointId !== "string") return null
  const checkpoint = record(row.continuationCheckpoint)
  return checkpoint ? { endpointId: row.endpointId, seedCheckpoint: checkpoint } : null
}

export function formatLongThinkElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  if (days) return `${days}天 ${hours}小时 ${minutes}分 ${secs}秒`
  if (hours) return `${hours}小时 ${minutes}分 ${secs}秒`
  if (minutes) return `${minutes}分 ${secs}秒`
  return `${secs}秒`
}
