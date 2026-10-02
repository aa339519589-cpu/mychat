export const MIN_PURE_THINKING_MS = 30_000
export const MIN_ACTIVE_CHECKPOINTS = 6
export const MIN_CHECKPOINT_INTERVAL_MS = 3_000
export const MAX_SILENT_THINKING_GAP_MS = 10_000

export const THINKING_STAGES = [
  { name: "decompose", instruction: "split the exact request into concrete claims and constraints" },
  { name: "analyze", instruction: "work through the claims and compare the viable answers" },
  { name: "verify", instruction: "check the important facts, calculations, and assumptions" },
  { name: "challenge", instruction: "try to falsify the current answer and find edge cases" },
  { name: "recheck", instruction: "independently re-evaluate the result and close remaining gaps" },
  { name: "synthesize", instruction: "write the concise final answer from the verified result" },
] as const
export type ThinkingStage = typeof THINKING_STAGES[number]["name"]

export type LongThinkCheckpointInput = {
  objective: string
  stage: string
  checkpoint?: string
  progress: string
  unresolved: string[]
  nextActions: string[]
  evidence?: string[]
  proposedAnswer?: string
  done?: boolean
}

export type ThinkingClockPhase = "thinking" | "paused"
export type ThinkingClock = {
  version: 1
  pureThinkingMs: number
  phase: ThinkingClockPhase
  lastThinkingAt: number | null
  checkpointCount: number
  lastProgressDigest: string | null
  stageIndex: number
}
export type ThinkingClockAction = "start" | "pause" | "resume"

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
