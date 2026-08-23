import { randomBytes } from "node:crypto"
import type { Database } from "@/lib/supabase/database.types"
import { jsonRecord, toJson } from "@/lib/supabase/json"
import type { SupabaseClient } from "@/lib/supabase/types"

export const MAESTRO_BRANCH = "maestro-runner-v1"
export const MAESTRO_META_KIND = "maestro.runner.v1"

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
}

export type MaestroMeta = {
  kind: typeof MAESTRO_META_KIND
  version: 1
  startCode: string
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
  currentInput: string
  currentRoundStartedAt: string | null
  totalElapsedMs: number
  lastOutput: string
  history: MaestroRoundRecord[]
}

export type MaestroReportState = {
  kind: "maestro-runner-state"
  jobId: string
  startCode: string
  objective: string
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
  startCode: string
  currentInput: string
  currentRoundStartedAt: string | null
  totalElapsedMs: number
  lastOutput: string
  history: MaestroRoundRecord[]
}

export type MaestroClientTask = Omit<MaestroPublicTask, "startCode">

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
    })
  }
  return result.slice(-100)
}

export function maestroMeta(row: Pick<AgentTaskRow, "meta">): MaestroMeta | null {
  const record = jsonRecord(row.meta)
  if (!record || record.kind !== MAESTRO_META_KIND) return null
  const startCode = text(record.startCode)
  if (!startCode) return null
  return {
    kind: MAESTRO_META_KIND,
    version: 1,
    startCode,
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
    startCode: meta.startCode,
    currentInput: meta.currentInput,
    currentRoundStartedAt: meta.currentRoundStartedAt,
    totalElapsedMs: meta.totalElapsedMs,
    lastOutput: meta.lastOutput,
    history: meta.history,
  }
}

export function clientMaestroTask(row: AgentTaskRow): MaestroClientTask | null {
  const task = publicMaestroTask(row)
  if (!task) return null
  const { startCode: internalStartCode, ...clientTask } = task
  void internalStartCode
  return clientTask
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
    startCode: randomBytes(18).toString("base64url"),
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

export async function findMaestroTaskByStartCode(client: SupabaseClient, startCode: string): Promise<AgentTaskRow | null> {
  const { data, error } = await client.from("agent_tasks")
    .select(TASK_SELECT)
    .eq("branch", MAESTRO_BRANCH)
    .filter("meta->>kind", "eq", MAESTRO_META_KIND)
    .filter("meta->>startCode", "eq", startCode)
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data as AgentTaskRow | null
}

export async function markMaestroRoundStarted(
  client: SupabaseClient,
  userId: string,
  jobId: string,
  round: number,
  input: string,
): Promise<{ row: AgentTaskRow; started: boolean }> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const row = await getMaestroTask(client, userId, jobId)
    if (!row) throw new Error("Maestro task not found")
    const meta = maestroMeta(row)
    if (!meta) throw new Error("Maestro task metadata is invalid")
    if (row.status === "cancelled" || row.status === "completed") return { row, started: false }
    if (round !== meta.round + 1) return { row, started: false }
    if (meta.currentRoundStartedAt) return { row, started: false }

    const now = new Date().toISOString()
    const { data, error } = await client.from("agent_tasks").update({
      status: "running",
      started_at: row.started_at ?? now,
      updated_at: now,
      meta: toJson({ ...meta, currentInput: input, currentRoundStartedAt: now }),
    })
      .eq("id", row.id)
      .eq("user_id", userId)
      .eq("branch", MAESTRO_BRANCH)
      .eq("updated_at", row.updated_at)
      .select(TASK_SELECT)
      .maybeSingle()
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
    meta: toJson({ ...meta, lastAction: "stop", lastReportedAt: now, currentRoundStartedAt: null }),
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
      currentInput: state.currentInput,
      currentRoundStartedAt: state.currentRoundStartedAt,
      totalElapsedMs: state.totalElapsedMs,
      lastOutput: state.lastOutput,
      history: state.history.slice(-100),
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
