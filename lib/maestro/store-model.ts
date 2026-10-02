import type { Database } from "@/lib/supabase/database.types"

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
