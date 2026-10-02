import type { JsonObject, JsonValue } from '@/lib/jobs/contracts'

export type LongThinkJobInput = {
  endpointId: string
  problem: string
  maxTokens: number
  minRounds: number
  verifyEvery: number
  seedCheckpoint: JsonObject | null
  continuedFrom: string | null
}

export type LongThinkUsage = {
  apiCalls: number
  inputTokens: number | null
  outputTokens: number | null
}

export type LongThinkRuntimeCheckpoint = {
  round: number
  state: JsonObject
  candidateAnswer: string
  lastReasoning: string
  lastStreamText: string
  usage: LongThinkUsage
  verifierRuns: number
  reviewerRuns: number
  transientErrors: number
  formatFailures: number
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function jsonObject(value: unknown): JsonObject | null {
  const row = object(value)
  return row ? row as JsonObject : null
}

function integer(value: unknown, minimum: number, maximum: number): number | null {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum
    ? Number(value)
    : null
}

function validatedJobNumbers(
  row: Record<string, unknown>,
  problem: string,
  maxTokens: number | null,
  minRounds: number | null,
  verifyEvery: number | null,
  seedCheckpoint: JsonObject | null,
): { maxTokens: number; minRounds: number; verifyEvery: number } | null {
  if (!problem || problem.length > 1_000_000 || maxTokens === null || minRounds === null || verifyEvery === null
    || (row.seedCheckpoint !== undefined && row.seedCheckpoint !== null && seedCheckpoint === null)) return null
  return { maxTokens, minRounds, verifyEvery }
}

function sanitizeJson(value: JsonValue): JsonValue {
  if (typeof value === 'string') return value.replaceAll('\u0000', '')
  if (Array.isArray(value)) return value.map(sanitizeJson)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitizeJson(entry)]))
  }
  return value
}

export function sanitizeLongThinkJsonObject(value: JsonObject): JsonObject {
  return sanitizeJson(value) as JsonObject
}

export function parseLongThinkJobInput(value: JsonValue): LongThinkJobInput {
  const row = object(value)
  if (!row) throw new TypeError('Long-think job input is invalid')
  const endpointId = typeof row.endpointId === 'string' ? row.endpointId : ''
  const problem = typeof row.problem === 'string' ? row.problem.trim() : ''
  const maxTokens = integer(row.maxTokens, 512, 262_144)
  const minRounds = integer(row.minRounds, 1, 100_000)
  const verifyEvery = integer(row.verifyEvery, 1, 10_000)
  const seedCheckpoint = row.seedCheckpoint === undefined || row.seedCheckpoint === null
    ? null : jsonObject(row.seedCheckpoint)
  const continuedFrom = typeof row.continuedFrom === 'string' ? row.continuedFrom : null
  const limits = validatedJobNumbers(row, problem, maxTokens, minRounds, verifyEvery, seedCheckpoint)
  if (!endpointId || !limits) {
    throw new TypeError('Long-think job input is invalid')
  }
  return { endpointId, problem, ...limits, seedCheckpoint, continuedFrom }
}

function nullableTokenCount(value: unknown): number | null {
  return value === null ? null : integer(value, 0, Number.MAX_SAFE_INTEGER)
}

function checkpointCounters(
  round: number | null,
  verifierRuns: number | null,
  reviewerRuns: number | null,
  transientErrors: number | null,
  formatFailures: number | null,
  apiCalls: number | null,
  inputTokens: number | null | undefined,
  outputTokens: number | null | undefined,
  state: Record<string, unknown> | null,
): { round: number; verifierRuns: number; reviewerRuns: number; transientErrors: number; formatFailures: number; apiCalls: number; inputTokens: number | null; outputTokens: number | null; state: Record<string, unknown> } | null {
  if (round === null || verifierRuns === null || reviewerRuns === null || transientErrors === null
    || formatFailures === null || apiCalls === null || inputTokens === undefined || outputTokens === undefined || state === null) return null
  return { round, verifierRuns, reviewerRuns, transientErrors, formatFailures, apiCalls, inputTokens, outputTokens, state }
}

export function initialLongThinkCheckpoint(): LongThinkRuntimeCheckpoint {
  return {
    round: 0,
    state: {},
    candidateAnswer: '',
    lastReasoning: '',
    lastStreamText: '',
    usage: { apiCalls: 0, inputTokens: 0, outputTokens: 0 },
    verifierRuns: 0,
    reviewerRuns: 0,
    transientErrors: 0,
    formatFailures: 0,
  }
}

export function parseLongThinkCheckpoint(value: JsonObject | null | undefined): LongThinkRuntimeCheckpoint {
  const row = object(value)
  if (!row) return initialLongThinkCheckpoint()
  const usage = object(row.usage)
  const state = object(row.state)
  const round = integer(row.round, 0, Number.MAX_SAFE_INTEGER)
  const verifierRuns = integer(row.verifierRuns, 0, Number.MAX_SAFE_INTEGER)
  const reviewerRuns = integer(row.reviewerRuns, 0, Number.MAX_SAFE_INTEGER)
  const transientErrors = integer(row.transientErrors, 0, Number.MAX_SAFE_INTEGER)
  const formatFailures = integer(row.formatFailures, 0, Number.MAX_SAFE_INTEGER)
  const apiCalls = integer(usage?.apiCalls, 0, Number.MAX_SAFE_INTEGER)
  const inputTokens = nullableTokenCount(usage?.inputTokens)
  const outputTokens = nullableTokenCount(usage?.outputTokens)
  const counters = checkpointCounters(round, verifierRuns, reviewerRuns, transientErrors, formatFailures, apiCalls, inputTokens, outputTokens, state)
  if (!counters) {
    return initialLongThinkCheckpoint()
  }
  return {
    round: counters.round,
    state: sanitizeLongThinkJsonObject(counters.state as JsonObject),
    candidateAnswer: typeof row.candidateAnswer === 'string' ? row.candidateAnswer.replaceAll('\u0000', '') : '',
    lastReasoning: typeof row.lastReasoning === 'string' ? row.lastReasoning.replaceAll('\u0000', '') : '',
    lastStreamText: typeof row.lastStreamText === 'string' ? row.lastStreamText.replaceAll('\u0000', '') : '',
    usage: { apiCalls: counters.apiCalls, inputTokens: counters.inputTokens, outputTokens: counters.outputTokens },
    verifierRuns: counters.verifierRuns,
    reviewerRuns: counters.reviewerRuns,
    transientErrors: counters.transientErrors,
    formatFailures: counters.formatFailures,
  }
}

export function checkpointJson(value: LongThinkRuntimeCheckpoint): JsonObject {
  return sanitizeLongThinkJsonObject(value as unknown as JsonObject)
}
