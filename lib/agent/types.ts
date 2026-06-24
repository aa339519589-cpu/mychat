// Agent Task 持久化系统：类型定义
// 所有类型对应 supabase/agent-tasks.sql 中的表结构

// ───────────── 任务 ─────────────

type AgentTaskMode = "auto" | "confirm" | "plan"

type AgentTaskStatus =
  | "queued"
  | "planning"
  | "editing"
  | "running"
  | "waiting_for_user"
  | "creating_pr"
  | "completed"
  | "failed"
  | "cancelled"

export type AgentTask = {
  id: string
  userId: string
  goal: string
  mode: AgentTaskMode
  repo: string | null
  branch: string
  status: AgentTaskStatus
  error: string | null
  meta: Record<string, unknown> | null
  createdAt: string
  updatedAt: string
  startedAt: string | null
  finishedAt: string | null
  agentBranch: string | null
  pullRequestUrl: string | null
  pullRequestNumber: number | null
  commitSha: string | null
}

// ───────────── 步骤 ─────────────

type StepKind = "info" | "thinking" | "plan" | "tool_call" | "confirm" | "error" | "done"

export type AgentTaskStep = {
  id: string
  taskId: string
  userId: string
  kind: StepKind
  label: string | null
  detail: string | null
  seq: number
  createdAt: string
}

// ───────────── 工具调用 ─────────────

type ToolCallStatus = "pending" | "running" | "success" | "error" | "cancelled"

export type AgentToolCall = {
  id: string
  taskId: string
  userId: string
  stepId: string | null
  toolName: string
  input: Record<string, unknown> | null
  output: Record<string, unknown> | null
  error: string | null
  status: ToolCallStatus
  startedAt: string | null
  finishedAt: string | null
  durationMs: number | null
  seq: number
  createdAt: string
}

// ───────────── Workspace ─────────────

type WorkspaceStatus = "created" | "cloning" | "ready" | "dirty" | "failed" | "cleaned"

export type AgentWorkspace = {
  id: string
  taskId: string
  userId: string
  repo: string
  branch: string
  commitSha: string | null
  path: string | null
  status: WorkspaceStatus
  createdAt: string
  updatedAt: string
}

// ───────────── 产物 ─────────────

type ArtifactKind = "diff" | "log" | "screenshot" | "build_report" | "test_report" | "deploy_link" | "pr_link" | "pr" | "deploy" | "file" | "summary" | "other"

export type AgentArtifact = {
  id: string
  taskId: string
  userId: string
  kind: ArtifactKind
  title: string | null
  content: string | null
  url: string | null
  meta: Record<string, unknown> | null
  createdAt: string
}

// ───────────── Snapshot 持久化记录 ─────────────

export type SnapshotRecord = {
  snapshotId: string
  taskId: string
  userId: string
  reason: string
  changedFiles: string[]
  createdFiles: string[]
  modifiedFiles: string[]
  deletedFiles: string[]
  createdAt: string
  diffSize: number
  storage: "local" | "artifact" | "both"
  restorable: boolean
  workspaceId: string | null
}

export type RestoreResult = {
  ok: boolean
  snapshotId?: string
  restoredFiles: number
  failedFiles: number
  usedSource: "local_patch" | "artifact_patch" | "git_fallback" | "none"
  error?: string
}

// ───────────── 聚合类型（含详情）─────────────

export type AgentTaskDetail = AgentTask & {
  steps: AgentTaskStep[]
  toolCalls: AgentToolCall[]
  workspace: AgentWorkspace | null
  artifacts: AgentArtifact[]
}

// ───────────── API 输入类型 ─────────────

export type CreateTaskInput = {
  goal: string
  mode?: AgentTaskMode
  repo?: string
  branch?: string
  meta?: Record<string, unknown>
}
