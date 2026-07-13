import type { AgentArtifact, AgentTask, AgentTaskStep, AgentToolCall, AgentWorkspace } from "./types"

// ───────────── 内部映射 ─────────────

export function mapTask(row: any): AgentTask {
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

export function mapStep(row: any): AgentTaskStep {
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

export function mapToolCall(row: any): AgentToolCall {
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

export function mapWorkspace(row: any): AgentWorkspace {
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

export function mapArtifact(row: any): AgentArtifact {
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

