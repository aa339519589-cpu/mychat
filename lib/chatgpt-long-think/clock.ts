import {
  MAX_SILENT_THINKING_GAP_MS,
  MIN_ACTIVE_CHECKPOINTS,
  MIN_CHECKPOINT_INTERVAL_MS,
  MIN_PURE_THINKING_MS,
  THINKING_STAGES,
  type LongThinkCheckpointInput,
  type ThinkingClock,
  type ThinkingClockPhase,
  type ThinkingStage,
} from "./protocol"

const MAX_TEXT = 24_000
const MAX_LIST = 64
const MAX_ITEM = 4_000

export function cleanText(value: unknown, maximum = MAX_TEXT): string {
  if (typeof value !== "string") return ""
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum)
}

export function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, MAX_LIST).map(item => cleanText(item, MAX_ITEM)).filter(Boolean)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null
}

type ParsedTimestamp = { value: number | null; valid: boolean }

function parseClockPhase(value: unknown): ThinkingClockPhase | null {
  if (value === "thinking" || value === "paused") return value
  return null
}

function parseClockTimestamp(value: unknown): ParsedTimestamp {
  if (value === null) return { value: null, valid: true }
  const parsed = finiteNonNegative(value)
  return { value: parsed, valid: parsed !== null }
}

function parseClockCount(value: unknown): number | null {
  const parsed = value === undefined ? 0 : finiteNonNegative(value)
  return parsed !== null && Number.isInteger(parsed) ? parsed : null
}

function parseClockStageIndex(value: unknown, checkpointCount: number): number | null {
  const parsed = value === undefined ? Math.min(checkpointCount, THINKING_STAGES.length) : finiteNonNegative(value)
  if (parsed === null || !Number.isInteger(parsed) || parsed > THINKING_STAGES.length) return null
  return parsed
}

function parseClockDigest(value: unknown): { value: string | null; valid: boolean } {
  if (value === undefined || value === null) return { value: null, valid: true }
  const valid = typeof value === "string" && /^[0-9a-f]{1,16}$/.test(value)
  return { value: valid ? value : null, valid }
}

function validClockPhaseTimestamp(phase: ThinkingClockPhase, timestamp: number | null): boolean {
  return phase === "thinking" ? timestamp !== null : timestamp === null
}

function validClockFields(
  pureThinkingMs: number | null,
  phase: ThinkingClockPhase | null,
  timestamp: ParsedTimestamp,
  checkpointCount: number | null,
  stageIndex: number | null,
  digest: { value: string | null; valid: boolean },
): boolean {
  return pureThinkingMs !== null
    && phase !== null
    && timestamp.valid
    && checkpointCount !== null
    && stageIndex !== null
    && digest.valid
}

export function progressDigest(input: LongThinkCheckpointInput): string {
  const value = JSON.stringify({
    stage: input.stage,
    progress: input.progress,
    unresolved: input.unresolved,
    nextActions: input.nextActions,
    evidence: input.evidence ?? [],
  })
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}

function clockFromValue(value: unknown): ThinkingClock | null {
  if (!isRecord(value)) return null
  const row = isRecord(value.clock) ? value.clock : value
  if (row.version !== 1) return null
  const pureThinkingMs = finiteNonNegative(row.pureThinkingMs)
  const phase = parseClockPhase(row.phase)
  const timestamp = parseClockTimestamp(row.lastThinkingAt)
  const checkpointCount = parseClockCount(row.checkpointCount)
  const stageIndex = checkpointCount === null ? null : parseClockStageIndex(row.stageIndex, checkpointCount)
  const digest = parseClockDigest(row.lastProgressDigest)
  if (!validClockFields(pureThinkingMs, phase, timestamp, checkpointCount, stageIndex, digest)
    || phase === null || checkpointCount === null || stageIndex === null || pureThinkingMs === null) return null
  if (!validClockPhaseTimestamp(phase, timestamp.value)) return null
  return { version: 1, pureThinkingMs, phase, lastThinkingAt: timestamp.value, checkpointCount, lastProgressDigest: digest.value, stageIndex }
}

export function clockFromCheckpoint(value: string): ThinkingClock | null {
  if (!value) return null
  try { return clockFromValue(JSON.parse(value)) } catch { return null }
}

export function startedClock(now = Date.now()): ThinkingClock {
  return { version: 1, pureThinkingMs: 0, phase: "thinking", lastThinkingAt: now, checkpointCount: 0, lastProgressDigest: null, stageIndex: 0 }
}

export function settledClock(clock: ThinkingClock, now = Date.now()): ThinkingClock {
  if (clock.phase !== "thinking" || clock.lastThinkingAt === null) return clock
  return {
    ...clock,
    pureThinkingMs: Math.min(Number.MAX_SAFE_INTEGER, clock.pureThinkingMs + Math.max(0, now - clock.lastThinkingAt)),
    lastThinkingAt: now,
  }
}

export function clockJson(clock: ThinkingClock): string {
  return JSON.stringify({ clock })
}

export function checkpointWithClock(checkpoint: string, clock: ThinkingClock): string {
  try {
    const parsed = JSON.parse(checkpoint)
    if (isRecord(parsed)) return JSON.stringify({ ...parsed, clock })
  } catch { /* use a clock-only checkpoint below */ }
  return clockJson(clock)
}

export function clockProgress(clock: ThinkingClock | null): { pureThinkingMs: number; remainingMs: number; phase: ThinkingClockPhase | "not_started"; checkpointCount: number; stageIndex: number; nextStage: ThinkingStage | "complete" } {
  if (!clock) return { pureThinkingMs: 0, remainingMs: MIN_PURE_THINKING_MS, phase: "not_started", checkpointCount: 0, stageIndex: 0, nextStage: THINKING_STAGES[0].name }
  const settled = settledClock(clock)
  return {
    pureThinkingMs: settled.pureThinkingMs,
    remainingMs: Math.max(0, MIN_PURE_THINKING_MS - settled.pureThinkingMs),
    phase: settled.phase,
    checkpointCount: settled.checkpointCount,
    stageIndex: settled.stageIndex,
    nextStage: THINKING_STAGES[settled.stageIndex]?.name ?? "complete",
  }
}

export function clockInstruction(clock: ThinkingClock | null): string {
  if (!clock) {
    return `Start the pure-thinking clock with long_think_clock(action="start") now. The minimum is ${MIN_PURE_THINKING_MS / 1000} seconds with no upper limit. Do not finish before it is reached.`
  }
  const progress = clockProgress(clock)
  if (progress.phase === "paused") {
    return "The pure-thinking clock is paused. After the external tool returns, call long_think_clock(action=\"resume\") before continuing. Tool time is excluded."
  }
  if (progress.remainingMs > 0) {
    const stage = THINKING_STAGES[progress.stageIndex]
    return `Keep thinking actively. Pure thinking recorded: ${Math.floor(progress.pureThinkingMs / 1000)}s; at least ${Math.ceil(progress.remainingMs / 1000)}s remains. Complete the next stage (${stage?.name ?? "synthesize"}): ${stage?.instruction ?? THINKING_STAGES[5].instruction}. Submit it as a new checkpoint after at least ${MIN_CHECKPOINT_INTERVAL_MS / 1000}s and never wait silently for more than ${MAX_SILENT_THINKING_GAP_MS / 1000}s. Checkpoints: ${progress.checkpointCount}/${MIN_ACTIVE_CHECKPOINTS}. Do not finish yet. There is no upper limit.`
  }
  if (progress.checkpointCount < MIN_ACTIVE_CHECKPOINTS) {
    const stage = THINKING_STAGES[progress.stageIndex]
    return `The time minimum has been reached, but ${MIN_ACTIVE_CHECKPOINTS - progress.checkpointCount} ordered work stages are still required. Complete ${stage?.name ?? "synthesize"}: ${stage?.instruction ?? THINKING_STAGES[5].instruction}. Keep thinking actively and do not finish yet.`
  }
  return "The active 30-second pure-thinking minimum has been reached. Continue until the problem is actually closed; there is no upper limit."
}
