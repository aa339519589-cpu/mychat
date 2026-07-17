import type { AgentArtifact, AgentTask, AgentTaskStep, AgentToolCall, AgentWorkspace } from "./types"
import type { Json } from '@/lib/supabase/database.types'
import { jsonRecord } from '@/lib/supabase/json'

// ───────────── 内部映射 ─────────────

type TaskRow = {
  id: string; user_id: string; goal: string; mode: string; repo?: string | null
  branch?: string | null; status: string; error?: string | null
  meta?: Json | null; created_at: string; updated_at: string
  started_at?: string | null; finished_at?: string | null; agent_branch?: string | null
  pull_request_url?: string | null; pull_request_number?: number | null; commit_sha?: string | null
}

type StepRow = {
  id: string; task_id: string; user_id: string; kind: string
  label?: string | null; detail?: string | null; seq: number; created_at: string
}

type ToolCallRow = {
  id: string; task_id: string; user_id: string; step_id?: string | null; tool_name: string
  input?: Json | null; output?: Json | null
  error?: string | null; status: string; started_at?: string | null
  finished_at?: string | null; duration_ms?: number | null; seq: number; created_at: string
}

type WorkspaceRow = {
  id: string; task_id: string; user_id: string; repo: string; branch?: string | null
  commit_sha?: string | null; path?: string | null; status: string
  created_at: string; updated_at: string
}

type ArtifactRow = {
  id: string; task_id: string; user_id: string; kind: string
  title?: string | null; content?: string | null; url?: string | null
  meta?: Json | null; created_at: string
}

function enumValue<const Values extends readonly string[]>(
  value: string,
  values: Values,
  field: string,
): Values[number] {
  if ((values as readonly string[]).includes(value)) return value as Values[number]
  throw new TypeError(`Invalid ${field}: ${value}`)
}

const TASK_MODES = ["auto", "confirm", "plan", "pr"] as const
const TASK_STATUSES = [
  "queued", "planning", "indexing", "reading", "editing", "running", "testing",
  "fixing", "reviewing", "waiting_for_user", "creating_pr", "deploying", "completed",
  "failed", "cancelled",
] as const
const STEP_KINDS = ["info", "thinking", "plan", "tool_call", "confirm", "error", "done"] as const
const TOOL_STATUSES = ["pending", "running", "success", "error", "cancelled"] as const
const WORKSPACE_STATUSES = ["created", "cloning", "ready", "dirty", "failed", "cleaned"] as const
const ARTIFACT_KINDS = [
  "diff", "log", "screenshot", "build_report", "test_report", "deploy_link", "pr_link",
  "pr", "deploy", "file", "summary", "other",
] as const

export function mapTask(row: TaskRow): AgentTask {
  return {
    id: row.id,
    userId: row.user_id,
    goal: row.goal,
    mode: enumValue(row.mode, TASK_MODES, 'agent task mode'),
    repo: row.repo ?? null,
    branch: row.branch ?? "main",
    status: enumValue(row.status, TASK_STATUSES, 'agent task status'),
    error: row.error ?? null,
    meta: jsonRecord(row.meta),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null,
    agentBranch: row.agent_branch ?? null,
    pullRequestUrl: row.pull_request_url ?? null,
    pullRequestNumber: row.pull_request_number ?? null,
    commitSha: row.commit_sha ?? null,
  }
}

export function mapStep(row: StepRow): AgentTaskStep {
  return {
    id: row.id,
    taskId: row.task_id,
    userId: row.user_id,
    kind: enumValue(row.kind, STEP_KINDS, 'agent step kind'),
    label: row.label ?? null,
    detail: row.detail ?? null,
    seq: row.seq,
    createdAt: row.created_at,
  }
}

export function mapToolCall(row: ToolCallRow): AgentToolCall {
  return {
    id: row.id,
    taskId: row.task_id,
    userId: row.user_id,
    stepId: row.step_id ?? null,
    toolName: row.tool_name,
    input: jsonRecord(row.input),
    output: jsonRecord(row.output),
    error: row.error ?? null,
    status: enumValue(row.status, TOOL_STATUSES, 'agent tool status'),
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null,
    durationMs: row.duration_ms ?? null,
    seq: row.seq,
    createdAt: row.created_at,
  }
}

export function mapWorkspace(row: WorkspaceRow): AgentWorkspace {
  return {
    id: row.id,
    taskId: row.task_id,
    userId: row.user_id,
    repo: row.repo,
    branch: row.branch ?? "main",
    commitSha: row.commit_sha ?? null,
    path: row.path ?? null,
    status: enumValue(row.status, WORKSPACE_STATUSES, 'agent workspace status'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function mapArtifact(row: ArtifactRow): AgentArtifact {
  return {
    id: row.id,
    taskId: row.task_id,
    userId: row.user_id,
    kind: enumValue(row.kind, ARTIFACT_KINDS, 'agent artifact kind'),
    title: row.title ?? null,
    content: row.content ?? null,
    url: row.url ?? null,
    meta: jsonRecord(row.meta),
    createdAt: row.created_at,
  }
}
