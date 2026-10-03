import { toJson } from "@/lib/supabase/json"
import type { SupabaseClient } from "@/lib/supabase/types"
import {
  MAESTRO_BRANCH,
  MAESTRO_META_KIND,
  normalizeHardRules,
  maestroMeta,
  publicMaestroTask,
  type AgentTaskRow,
  type MaestroContract,
  type MaestroMeta,
  type MaestroAction,
  type MaestroPhase,
  type MaestroPublicTask,
  type MaestroReportState,
} from "./store-model"

export * from "./store-model"

const TASK_SELECT = "id,user_id,goal,mode,repo,branch,status,error,created_at,updated_at,started_at,finished_at,meta,agent_branch,pull_request_url,pull_request_number,commit_sha"

export async function createMaestroTask(
  client: SupabaseClient,
  userId: string,
  objective: string,
  maxRounds: number,
  contract: MaestroContract = {},
): Promise<AgentTaskRow> {
  const now = new Date().toISOString()
  const successCriterion = contract.successCriterion?.trim() || objective
  const meta: MaestroMeta = {
    kind: MAESTRO_META_KIND,
    version: 1,
    maxRounds,
    round: 0,
    phase: "work",
    successCriterion,
    hardRules: normalizeHardRules(contract.hardRules ?? []),
    checkpoint: "",
    unresolved: [],
    nextActions: [],
    evidence: [],
    candidateAnswer: "",
    finalAnswer: "",
    criterionSatisfied: false,
    reviewEvidence: [],
    completionVerified: false,
    lastAction: "queued",
    lastReportedAt: null,
    currentInput: "",
    currentRoundStartedAt: null,
    totalElapsedMs: 0,
    lastOutput: "",
    history: [],
  }
  const { data, error } = await client.from("agent_tasks").insert({
    user_id: userId,
    goal: objective,
    mode: "plan",
    branch: MAESTRO_BRANCH,
    status: "queued",
    meta: toJson(meta),
    updated_at: now,
  }).select(TASK_SELECT).single()
  if (error || !data) throw new Error(error?.message ?? "Maestro task creation failed")
  return data as AgentTaskRow
}

export async function listMaestroTasks(client: SupabaseClient, userId: string): Promise<AgentTaskRow[]> {
  const { data, error } = await client.from("agent_tasks").select(TASK_SELECT).eq("user_id", userId).eq("branch", MAESTRO_BRANCH).order("created_at", { ascending: false }).limit(100)
  if (error) throw new Error(error.message)
  return (data ?? []) as AgentTaskRow[]
}

export async function getMaestroTask(client: SupabaseClient, userId: string, jobId: string): Promise<AgentTaskRow | null> {
  const { data, error } = await client.from("agent_tasks").select(TASK_SELECT).eq("id", jobId).eq("user_id", userId).eq("branch", MAESTRO_BRANCH).maybeSingle()
  if (error) throw new Error(error.message)
  return data as AgentTaskRow | null
}

export async function markMaestroRoundStarted(client: SupabaseClient, userId: string, jobId: string, round: number, input: string): Promise<{ row: AgentTaskRow; started: boolean }> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const row = await getMaestroTask(client, userId, jobId)
    if (!row) throw new Error("Maestro task not found")
    const meta = maestroMeta(row)
    if (!meta) throw new Error("Maestro task metadata is invalid")
    if (row.status === "cancelled" || row.status === "completed") return { row, started: false }
    if (round !== meta.round + 1 || meta.currentRoundStartedAt) return { row, started: false }
    const now = new Date().toISOString()
    const extendedMaxRounds = round > meta.maxRounds
      ? Math.max(round + 999, Math.max(2, meta.maxRounds) * 2)
      : meta.maxRounds
    const { data, error } = await client.from("agent_tasks").update({
      status: "running",
      started_at: row.started_at ?? now,
      finished_at: null,
      updated_at: now,
      meta: toJson({ ...meta, maxRounds: extendedMaxRounds, currentInput: input, currentRoundStartedAt: now }),
    }).eq("id", row.id).eq("user_id", userId).eq("branch", MAESTRO_BRANCH).eq("updated_at", row.updated_at).select(TASK_SELECT).maybeSingle()
    if (error) throw new Error(error.message)
    if (data) return { row: data as AgentTaskRow, started: true }
  }
  throw new Error("Maestro task changed concurrently; retry round start")
}

export async function cancelMaestroTask(client: SupabaseClient, userId: string, jobId: string): Promise<boolean> {
  const row = await getMaestroTask(client, userId, jobId)
  if (!row) return false
  const meta = maestroMeta(row)
  if (!meta) return false
  const now = new Date().toISOString()
  const { error } = await client.from("agent_tasks").update({
    status: "cancelled",
    finished_at: now,
    updated_at: now,
    meta: toJson({ ...meta, lastAction: "stop", lastReportedAt: now, currentRoundStartedAt: null, completionVerified: false }),
  }).eq("id", jobId).eq("user_id", userId).eq("branch", MAESTRO_BRANCH)
  if (error) throw new Error(error.message)
  return true
}

export async function applyMaestroReport(client: SupabaseClient, userId: string, jobId: string, state: MaestroReportState): Promise<MaestroPublicTask> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const row = await getMaestroTask(client, userId, jobId)
    if (!row) throw new Error("Maestro task not found")
    const meta = maestroMeta(row)
    const existing = publicMaestroTask(row)
    if (!meta || !existing) throw new Error("Maestro task metadata is invalid")
    if (row.status === "cancelled" || row.status === "completed" || state.round < meta.round) return existing

    const verifiedCompletion = state.action === "finish"
      && state.phase === "done"
      && state.completionVerified === true
      && state.criterionSatisfied === true
      && state.reviewEvidence.length > 0
      && Boolean(state.finalAnswer.trim())

    const safePhase: MaestroPhase = verifiedCompletion ? "done" : state.phase === "done" ? "work" : state.phase
    const safeAction: MaestroAction = verifiedCompletion ? "finish" : state.action === "finish" ? "continue" : state.action
    const now = new Date().toISOString()
    const nextMeta: MaestroMeta = {
      ...meta,
      round: state.round,
      phase: safePhase,
      checkpoint: state.checkpoint,
      unresolved: state.unresolved,
      nextActions: state.nextActions,
      evidence: state.evidence,
      candidateAnswer: state.candidateAnswer,
      finalAnswer: verifiedCompletion ? state.finalAnswer : "",
      criterionSatisfied: verifiedCompletion,
      reviewEvidence: verifiedCompletion ? state.reviewEvidence : state.reviewEvidence,
      completionVerified: verifiedCompletion,
      lastAction: safeAction,
      lastReportedAt: now,
      currentInput: state.currentInput,
      currentRoundStartedAt: state.currentRoundStartedAt,
      totalElapsedMs: state.totalElapsedMs,
      lastOutput: state.lastOutput,
      history: state.history.slice(-100),
    }
    const patch = {
      status: verifiedCompletion ? "completed" : "running",
      started_at: row.started_at ?? now,
      finished_at: verifiedCompletion ? now : null,
      updated_at: now,
      meta: toJson(nextMeta),
    }
    const { data, error } = await client.from("agent_tasks").update(patch).eq("id", row.id).eq("user_id", userId).eq("branch", MAESTRO_BRANCH).eq("updated_at", row.updated_at).select(TASK_SELECT).maybeSingle()
    if (error) throw new Error(error.message)
    if (data) {
      const result = publicMaestroTask(data as AgentTaskRow)
      if (!result) throw new Error("Updated Maestro task is invalid")
      return result
    }
  }
  throw new Error("Maestro task changed concurrently; retry the report")
}
