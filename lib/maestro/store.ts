import type { Database } from "@/lib/supabase/database.types"
import { jsonRecord, toJson } from "@/lib/supabase/json"
import type { SupabaseClient } from "@/lib/supabase/types"

export const MAESTRO_BRANCH = "maestro-runner-v1"
export const MAESTRO_META_KIND = "maestro.runner.v1"

export type MaestroPhase = "work" | "review" | "done"
export type MaestroAction = "continue" | "review" | "finish" | "stop"
export type AgentTaskRow = Database["public"]["Tables"]["agent_tasks"]["Row"]

export type MaestroMeta = {
  kind: typeof MAESTRO_META_KIND
  version: 1
  maxRounds: number
  round: number
  phase: MaestroPhase
  checkpoint: string
  unresolved: string[]
  nextActions: string[]
  evidence: string[]
  candidateAnswer: string
  finalAnswer: string
  lastAction: MaestroAction | "queued"
  lastReportedAt: string | null
}

export type MaestroReportState = {
  kind: "maestro-runner-state"
  jobId: string
  taskToken: string
  objective: string
  round: number
  phase: MaestroPhase
  action: MaestroAction
  checkpoint: string
  unresolved: string[]
  nextActions: string[]
  evidence: string[]
  candidateAnswer: string
  finalAnswer: string
  nextPrompt: string
}

export type MaestroPublicTask = {
  id: string
  objective: string
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
  lastAction: MaestroMeta["lastAction"]
  lastReportedAt: string | null
  createdAt: string
  updatedAt: string
  startedAt: string | null
  finishedAt: string | null
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

export function maestroMeta(row: Pick<AgentTaskRow, "meta">): MaestroMeta | null {
  const record = jsonRecord(row.meta)
  if (!record || record.kind !== MAESTRO_META_KIND) return null
  return {
    kind: MAESTRO_META_KIND,
    version: 1,
    maxRounds: Math.max(1, integer(record.maxRounds, 1000)),
    round: integer(record.round, 0),
    phase: phase(record.phase),
    checkpoint: text(record.checkpoint),
    unresolved: strings(record.unresolved),
    nextActions: strings(record.nextActions),
    evidence: strings(record.evidence),
    candidateAnswer: text(record.candidateAnswer),
    finalAnswer: text(record.finalAnswer),
    lastAction: action(record.lastAction),
    lastReportedAt: typeof record.lastReportedAt === "string" ? record.lastReportedAt : null,
  }
}

export function publicMaestroTask(row: AgentTaskRow): MaestroPublicTask | null {
  const meta = maestroMeta(row)
  if (!meta) return null
  return {
    id: row.id,
    objective: row.goal,
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
    lastAction: meta.lastAction,
    lastReportedAt: meta.lastReportedAt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }
}

const TASK_SELECT = "id,user_id,goal,mode,repo,branch,status,error,created_at,updated_at,started_at,finished_at,meta,agent_branch,pull_request_url,pull_request_number,commit_sha"

export async function createMaestroTask(
  client: SupabaseClient,
  userId: string,
  objective: string,
  maxRounds: number,
): Promise<AgentTaskRow> {
  const now = new Date().toISOString()
  const meta: MaestroMeta = {
    kind: MAESTRO_META_KIND,
    version: 1,
    maxRounds,
    round: 0,
    phase: "work",
    checkpoint: "",
    unresolved: [],
    nextActions: [],
    evidence: [],
    candidateAnswer: "",
    finalAnswer: "",
    lastAction: "queued",
    lastReportedAt: null,
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
  const { data, error } = await client.from("agent_tasks")
    .select(TASK_SELECT)
    .eq("user_id", userId)
    .eq("branch", MAESTRO_BRANCH)
    .order("created_at", { ascending: false })
    .limit(100)
  if (error) throw new Error(error.message)
  return (data ?? []) as AgentTaskRow[]
}

export async function getMaestroTask(client: SupabaseClient, userId: string, jobId: string): Promise<AgentTaskRow | null> {
  const { data, error } = await client.from("agent_tasks")
    .select(TASK_SELECT)
    .eq("id", jobId)
    .eq("user_id", userId)
    .eq("branch", MAESTRO_BRANCH)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data as AgentTaskRow | null
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
    meta: toJson({ ...meta, lastAction: "stop", lastReportedAt: now }),
  }).eq("id", jobId).eq("user_id", userId).eq("branch", MAESTRO_BRANCH)
  if (error) throw new Error(error.message)
  return true
}

export async function applyMaestroReport(
  client: SupabaseClient,
  userId: string,
  jobId: string,
  state: MaestroReportState,
): Promise<MaestroPublicTask> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const row = await getMaestroTask(client, userId, jobId)
    if (!row) throw new Error("Maestro task not found")
    const meta = maestroMeta(row)
    if (!meta) throw new Error("Maestro task metadata is invalid")
    const existing = publicMaestroTask(row)
    if (!existing) throw new Error("Maestro task is invalid")
    if (row.status === "cancelled" || row.status === "completed") return existing
    if (state.round < meta.round) return existing

    const now = new Date().toISOString()
    const nextMeta: MaestroMeta = {
      ...meta,
      round: state.round,
      phase: state.phase,
      checkpoint: state.checkpoint,
      unresolved: state.unresolved,
      nextActions: state.nextActions,
      evidence: state.evidence,
      candidateAnswer: state.candidateAnswer,
      finalAnswer: state.finalAnswer,
      lastAction: state.action,
      lastReportedAt: now,
    }
    const completed = state.action === "finish" && state.phase === "done" && Boolean(state.finalAnswer.trim())
    const patch = {
      status: completed ? "completed" : "running",
      started_at: row.started_at ?? now,
      finished_at: completed ? now : null,
      updated_at: now,
      meta: toJson(nextMeta),
    }
    const { data, error } = await client.from("agent_tasks").update(patch)
      .eq("id", row.id)
      .eq("user_id", userId)
      .eq("branch", MAESTRO_BRANCH)
      .eq("updated_at", row.updated_at)
      .select(TASK_SELECT)
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (data) {
      const result = publicMaestroTask(data as AgentTaskRow)
      if (!result) throw new Error("Updated Maestro task is invalid")
      return result
    }
  }
  throw new Error("Maestro task changed concurrently; retry the report")
}
