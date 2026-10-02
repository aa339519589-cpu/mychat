import type { Database } from "@/lib/supabase/database.types"
import { jsonRecord } from "@/lib/supabase/json"

export const MAESTRO_BRANCH = "maestro-runner-v1"
export const MAESTRO_META_KIND = "maestro.runner.v1"

export const MAESTRO_BUILTIN_HARD_RULES = [
  "The objective and success criterion are authoritative and immutable for the lifetime of the task.",
  "done=true means the exact success criterion has actually been satisfied; inability, difficulty, time spent, round count, token limits, tool limits, lack of progress, or an unknown method never count as completion.",
  "A work round can never finish the task. Only a separate independent review round may finish it after verifying the exact immutable success criterion.",
  "If execution is interrupted or a platform/runtime boundary is reached before success, preserve the task as unfinished and resumable; never convert the interruption into success.",
] as const

export type MaestroPhase = "work" | "review" | "done"
export type MaestroAction = "continue" | "review" | "finish" | "stop"
export type AgentTaskRow = Database["public"]["Tables"]["agent_tasks"]["Row"]

export type MaestroRoundRecord = {
  round: number
  phase: Exclude<MaestroPhase, "done">
  input: string
  output: string
  checkpoint: string
  action: MaestroAction
  startedAt: string
  finishedAt: string
  elapsedMs: number
  criterionSatisfied: boolean
  reviewEvidence: string[]
  completionVerified: boolean
}

export type MaestroMeta = {
  kind: typeof MAESTRO_META_KIND
  version: 1
  maxRounds: number
  round: number
  phase: MaestroPhase
  successCriterion: string
  hardRules: string[]
  checkpoint: string
  unresolved: string[]
  nextActions: string[]
  evidence: string[]
  candidateAnswer: string
  finalAnswer: string
  criterionSatisfied: boolean
  reviewEvidence: string[]
  completionVerified: boolean
  lastAction: MaestroAction | "queued"
  lastReportedAt: string | null
  currentInput: string
  currentRoundStartedAt: string | null
  totalElapsedMs: number
  lastOutput: string
  history: MaestroRoundRecord[]
}

export type MaestroReportState = {
  kind: "maestro-runner-state"
  jobId: string
  taskToken: string
  objective: string
  successCriterion: string
  hardRules: string[]
  status: string
  round: number
  phase: MaestroPhase
  action: MaestroAction
  checkpoint: string
  unresolved: string[]
  nextActions: string[]
  evidence: string[]
  candidateAnswer: string
  finalAnswer: string
  criterionSatisfied: boolean
  reviewEvidence: string[]
  completionVerified: boolean
  nextPrompt: string
  currentInput: string
  currentRoundStartedAt: string | null
  totalElapsedMs: number
  lastOutput: string
  history: MaestroRoundRecord[]
  createdAt: string
  updatedAt: string
  launchGranted: boolean
}

export type MaestroPublicTask = {
  id: string
  objective: string
  successCriterion: string
  hardRules: string[]
  status: string
  round: number
  phase: MaestroPhase
  maxRounds: number
  checkpoint: string
  unresolved: string[]
  nextActions: string[]
  evidence: string[]
  candidateAnswer: string
  finalAnswer: string
  criterionSatisfied: boolean
  reviewEvidence: string[]
  completionVerified: boolean
  lastAction: MaestroMeta["lastAction"]
  lastReportedAt: string | null
  createdAt: string
  updatedAt: string
  startedAt: string | null
  finishedAt: string | null
  currentInput: string
  currentRoundStartedAt: string | null
  totalElapsedMs: number
  lastOutput: string
  history: MaestroRoundRecord[]
}

export type MaestroClientTask = MaestroPublicTask

export type MaestroContract = {
  successCriterion?: string
  hardRules?: string[]
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function integer(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : fallback
}

function phase(value: unknown): MaestroPhase {
  return value === "review" || value === "done" ? value : "work"
}

function action(value: unknown): MaestroMeta["lastAction"] {
  return value === "continue" || value === "review" || value === "finish" || value === "stop" ? value : "queued"
}

export function normalizeHardRules(value: string[]): string[] {
  const unique = new Set<string>()
  for (const rule of [...MAESTRO_BUILTIN_HARD_RULES, ...value]) {
    const cleaned = rule.trim()
    if (cleaned) unique.add(cleaned)
  }
  return [...unique].slice(0, 64)
}

function rounds(value: unknown): MaestroRoundRecord[] {
  if (!Array.isArray(value)) return []
  const result: MaestroRoundRecord[] = []
  for (const item of value) {
    const row = jsonRecord(item)
    if (!row) continue
    const round = integer(row.round, 0)
    const recordPhase = row.phase === "review" ? "review" : row.phase === "work" ? "work" : null
    const recordAction = action(row.action)
    if (round < 1 || !recordPhase || recordAction === "queued") continue
    result.push({
      round,
      phase: recordPhase,
      input: text(row.input),
      output: text(row.output),
      checkpoint: text(row.checkpoint),
      action: recordAction,
      startedAt: text(row.startedAt),
      finishedAt: text(row.finishedAt),
      elapsedMs: integer(row.elapsedMs, 0),
      criterionSatisfied: row.criterionSatisfied === true,
      reviewEvidence: strings(row.reviewEvidence),
      completionVerified: row.completionVerified === true,
    })
  }
  return result.slice(-100)
}

export function maestroMeta(row: Pick<AgentTaskRow, "meta">): MaestroMeta | null {
  const record = jsonRecord(row.meta)
  if (!record || record.kind !== MAESTRO_META_KIND) return null
  return {
    kind: MAESTRO_META_KIND,
    version: 1,
    maxRounds: Math.max(1, integer(record.maxRounds, 1000)),
    round: integer(record.round, 0),
    phase: phase(record.phase),
    successCriterion: text(record.successCriterion),
    hardRules: normalizeHardRules(strings(record.hardRules)),
    checkpoint: text(record.checkpoint),
    unresolved: strings(record.unresolved),
    nextActions: strings(record.nextActions),
    evidence: strings(record.evidence),
    candidateAnswer: text(record.candidateAnswer),
    finalAnswer: text(record.finalAnswer),
    criterionSatisfied: record.criterionSatisfied === true,
    reviewEvidence: strings(record.reviewEvidence),
    completionVerified: record.completionVerified === true,
    lastAction: action(record.lastAction),
    lastReportedAt: typeof record.lastReportedAt === "string" ? record.lastReportedAt : null,
    currentInput: text(record.currentInput),
    currentRoundStartedAt: typeof record.currentRoundStartedAt === "string" ? record.currentRoundStartedAt : null,
    totalElapsedMs: integer(record.totalElapsedMs, 0),
    lastOutput: text(record.lastOutput),
    history: rounds(record.history),
  }
}

export function publicMaestroTask(row: AgentTaskRow): MaestroPublicTask | null {
  const meta = maestroMeta(row)
  if (!meta) return null
  return {
    id: row.id,
    objective: row.goal,
    successCriterion: meta.successCriterion || row.goal,
    hardRules: meta.hardRules,
    status: row.status,
    round: meta.round,
    phase: meta.phase,
    maxRounds: meta.maxRounds,
    checkpoint: meta.checkpoint,
    unresolved: meta.unresolved,
    nextActions: meta.nextActions,
    evidence: meta.evidence,
    candidateAnswer: meta.candidateAnswer,
    finalAnswer: meta.finalAnswer,
    criterionSatisfied: meta.criterionSatisfied,
    reviewEvidence: meta.reviewEvidence,
    completionVerified: meta.completionVerified,
    lastAction: meta.lastAction,
    lastReportedAt: meta.lastReportedAt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    currentInput: meta.currentInput,
    currentRoundStartedAt: meta.currentRoundStartedAt,
    totalElapsedMs: meta.totalElapsedMs,
    lastOutput: meta.lastOutput,
    history: meta.history,
  }
}

export function clientMaestroTask(row: AgentTaskRow): MaestroClientTask | null {
  return publicMaestroTask(row)
}
