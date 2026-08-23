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
  if (!endpointId || !problem || problem.length > 1_000_000 || maxTokens === null || minRounds === null || verifyEvery === null
    || (row.seedCheckpoint !== undefined && row.seedCheckpoint !== null && seedCheckpoint === null)) {
    throw new TypeError('Long-think job input is invalid')
  }
  return { endpointId, problem, maxTokens, minRounds, verifyEvery, seedCheckpoint, continuedFrom }
}

function nullableTokenCount(value: unknown): number | null {
  return value === null ? null : integer(value, 0, Number.MAX_SAFE_INTEGER)
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
  if (round === null || verifierRuns === null || reviewerRuns === null || transientErrors === null
    || formatFailures === null || apiCalls === null || inputTokens === undefined || outputTokens === undefined || !state) {
    return initialLongThinkCheckpoint()
  }
  return {
    round,
    state: state as JsonObject,
    candidateAnswer: typeof row.candidateAnswer === 'string' ? row.candidateAnswer : '',
    lastReasoning: typeof row.lastReasoning === 'string' ? row.lastReasoning : '',
    lastStreamText: typeof row.lastStreamText === 'string' ? row.lastStreamText : '',
    usage: { apiCalls, inputTokens, outputTokens },
    verifierRuns,
    reviewerRuns,
    transientErrors,
    formatFailures,
  }
}

export function checkpointJson(value: LongThinkRuntimeCheckpoint): JsonObject {
  return value as unknown as JsonObject
}
