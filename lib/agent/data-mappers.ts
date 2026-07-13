import type { AgentArtifact, AgentTask, AgentTaskStep, AgentToolCall, AgentWorkspace } from "./types"

// ───────────── 内部映射 ─────────────

type TaskRow = {
  id: string; user_id: string; goal: string; mode: AgentTask['mode']; repo?: string | null
  branch?: string | null; status: AgentTask['status']; error?: string | null
  meta?: Record<string, unknown> | null; created_at: string; updated_at: string
  started_at?: string | null; finished_at?: string | null; agent_branch?: string | null
  pull_request_url?: string | null; pull_request_number?: number | null; commit_sha?: string | null
}

type StepRow = {
  id: string; task_id: string; user_id: string; kind: AgentTaskStep['kind']
  label?: string | null; detail?: string | null; seq: number; created_at: string
}

type ToolCallRow = {
  id: string; task_id: string; user_id: string; step_id?: string | null; tool_name: string
  input?: Record<string, unknown> | null; output?: Record<string, unknown> | null
  error?: string | null; status: AgentToolCall['status']; started_at?: string | null
  finished_at?: string | null; duration_ms?: number | null; seq: number; created_at: string
}

type WorkspaceRow = {
  id: string; task_id: string; user_id: string; repo: string; branch?: string | null
  commit_sha?: string | null; path?: string | null; status: AgentWorkspace['status']
  created_at: string; updated_at: string
}

type ArtifactRow = {
  id: string; task_id: string; user_id: string; kind: AgentArtifact['kind']
  title?: string | null; content?: string | null; url?: string | null
  meta?: Record<string, unknown> | null; created_at: string
}

export function mapTask(row: TaskRow): AgentTask {
  return {
    id: row.id,
    userId: row.user_id,
    goal: row.goal,
    mode: row.mode,
    repo: row.repo ?? null,
    branch: row.branch ?? "main",
    status: row.status,
    error: row.error ?? null,
    meta: row.meta ?? null,
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
    kind: row.kind,
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
    input: row.input ?? null,
    output: row.output ?? null,
    error: row.error ?? null,
    status: row.status,
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
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function mapArtifact(row: ArtifactRow): AgentArtifact {
  return {
    id: row.id,
    taskId: row.task_id,
    userId: row.user_id,
    kind: row.kind,
    title: row.title ?? null,
    content: row.content ?? null,
    url: row.url ?? null,
    meta: row.meta ?? null,
    createdAt: row.created_at,
  }
}
