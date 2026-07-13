// Agent Task 持久化：数据访问层
// 所有函数接受已有的 Supabase 客户端（API route 从 resolveAuth 获得），不自行创建。
// 设计原则：
//  - 绝不信任前端传来的 user_id，由调用方从服务端 Session 注入
//  - taskId 查询必须确认属于当前用户
//  - 错误明确返回，不吞掉
//  - 风格贴近 lib/code-data.ts
import type { SupabaseClient } from "@supabase/supabase-js"
import type {
  AgentTask, AgentTaskDetail, AgentTaskStep, AgentToolCall,
  AgentWorkspace, AgentArtifact, CreateTaskInput,
  AgentTaskStatus, StepKind, ToolCallStatus, WorkspaceStatus,
} from "./types"
import { mapArtifact, mapStep, mapTask, mapToolCall, mapWorkspace } from "./data-mappers"


// ───────────── 任务 CRUD ─────────────

// 创建任务
export async function createTask(
  supabase: SupabaseClient,
  userId: string,
  input: CreateTaskInput,
): Promise<AgentTask | { error: string }> {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const { error, data } = await supabase
    .from("agent_tasks")
    .insert({
      id,
      user_id: userId,
      goal: input.goal,
      mode: input.mode ?? "auto",
      repo: input.repo ?? null,
      branch: input.branch ?? "main",
      status: "queued",
      meta: input.meta ?? null,
      created_at: now,
      updated_at: now,
    })
    .select()
    .single()

  if (error || !data) {
    console.error('[agent/data] createTask failed', {
      message: error?.message,
      code: error?.code,
      details: error?.details,
      hint: error?.hint,
      payload: { id, userId, goal: input.goal?.slice(0, 80), mode: input.mode ?? "auto", repo: input.repo }
    })
    return { error: error?.message ?? "创建任务失败" }
  }
  return mapTask(data)
}

// 用户任务列表
export async function listTasks(
  supabase: SupabaseClient,
  userId: string,
  opts?: { status?: string; repo?: string; limit?: number },
): Promise<AgentTask[]> {
  let q = supabase
    .from("agent_tasks")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(opts?.limit ?? 20)

  if (opts?.status) q = q.eq("status", opts.status)
  if (opts?.repo) q = q.eq("repo", opts.repo)

  const { data } = await q
  return (data ?? []).map(mapTask)
}

// 任务详情（含 steps / tool_calls / workspace / artifacts）
export async function getTaskDetail(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
): Promise<AgentTaskDetail | { error: string }> {
  // ① 查任务，确认归属
  const { data: task, error: taskErr } = await supabase
    .from("agent_tasks")
    .select("*")
    .eq("id", taskId)
    .eq("user_id", userId)
    .single()

  if (taskErr || !task) return { error: taskErr?.message ?? "任务不存在" }

  // ② 并行查关联数据
  const [stepsRes, toolCallsRes, wsRes, artifactsRes] = await Promise.all([
    supabase.from("agent_task_steps").select("*").eq("task_id", taskId).eq("user_id", userId).order("seq"),
    supabase.from("agent_tool_calls").select("*").eq("task_id", taskId).eq("user_id", userId).order("seq"),
    supabase.from("agent_workspaces").select("*").eq("task_id", taskId).eq("user_id", userId).limit(1),
    supabase.from("agent_artifacts").select("*").eq("task_id", taskId).eq("user_id", userId).order("created_at"),
  ])

  return {
    ...mapTask(task),
    steps: (stepsRes.data ?? []).map(mapStep),
    toolCalls: (toolCallsRes.data ?? []).map(mapToolCall),
    workspace: wsRes.data?.length ? mapWorkspace(wsRes.data[0]) : null,
    artifacts: (artifactsRes.data ?? []).map(mapArtifact),
  }
}

// 更新任务状态
export async function updateTaskStatus(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
  status: AgentTaskStatus,
  extra?: {
    error?: string | null
    startedAt?: string
    finishedAt?: string | null
    agentBranch?: string
    pullRequestUrl?: string
    pullRequestNumber?: number
    commitSha?: string
  },
): Promise<AgentTask | { error: string }> {
  const update: Record<string, unknown> = {
    status,
    updated_at: new Date().toISOString(),
  }
  if (extra?.error !== undefined) update.error = extra.error
  if (extra?.startedAt !== undefined) update.started_at = extra.startedAt
  if (extra?.finishedAt !== undefined) update.finished_at = extra.finishedAt
  if (extra?.agentBranch) update.agent_branch = extra.agentBranch
  if (extra?.pullRequestUrl) update.pull_request_url = extra.pullRequestUrl
  if (extra?.pullRequestNumber != null) update.pull_request_number = extra.pullRequestNumber
  if (extra?.commitSha) update.commit_sha = extra.commitSha

  const { error, data } = await supabase
    .from("agent_tasks")
    .update(update)
    .eq("id", taskId)
    .eq("user_id", userId)
    .select()
    .single()

  if (error || !data) return { error: error?.message ?? "更新失败" }
  return mapTask(data)
}

// 取消任务
export async function cancelTask(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
): Promise<AgentTask | { error: string }> {
  const { data } = await supabase.from("agent_tasks").select("status")
    .eq("id", taskId).eq("user_id", userId).maybeSingle()
  if (!data) return { error: "任务不存在" }
  if (["completed", "failed", "cancelled"].includes(data.status)) {
    return { error: `当前状态 ${data.status} 不可取消` }
  }
  return updateTaskStatus(supabase, userId, taskId, "cancelled", {
    finishedAt: new Date().toISOString(),
  })
}

// 恢复任务
export async function resumeTask(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
): Promise<AgentTask | { error: string }> {
  // 只允许恢复 cancelled / failed / waiting_for_user 的任务
  const { data: task } = await supabase
    .from("agent_tasks")
    .select("status")
    .eq("id", taskId)
    .eq("user_id", userId)
    .single()

  if (!task) return { error: "任务不存在" }
  if (!["cancelled", "failed", "waiting_for_user"].includes(task.status)) {
    return { error: `当前状态 ${task.status} 不可恢复` }
  }

  return updateTaskStatus(supabase, userId, taskId, "queued", {
    error: null,
    finishedAt: null,
  })
}

// ───────────── 步骤 ─────────────

export async function addStep(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
  step: { kind: StepKind; label?: string; detail?: string },
): Promise<AgentTaskStep | { error: string }> {
  const id = crypto.randomUUID()

  const { error, data } = await supabase
    .from("agent_task_steps")
    .insert({
      id,
      task_id: taskId,
      user_id: userId,
      kind: step.kind,
      label: step.label ?? null,
      detail: step.detail ?? null,
    })
    .select()
    .single()

  if (error || !data) return { error: error?.message ?? "写入步骤失败" }

  // touch 任务 updated_at
  await supabase.from("agent_tasks").update({ updated_at: new Date().toISOString() }).eq("id", taskId).eq("user_id", userId)

  return mapStep(data)
}

// ───────────── 工具调用 ─────────────

export async function addToolCall(
  supabase: SupabaseClient,
  userId: string,
  tc: {
    taskId: string
    stepId?: string
    toolName: string
    input?: Record<string, unknown>
    status?: ToolCallStatus
  },
): Promise<AgentToolCall | { error: string }> {
  const id = crypto.randomUUID()

  const { error, data } = await supabase
    .from("agent_tool_calls")
    .insert({
      id,
      task_id: tc.taskId,
      user_id: userId,
      step_id: tc.stepId ?? null,
      tool_name: tc.toolName,
      input: tc.input ?? null,
      status: tc.status ?? "pending",
      started_at: new Date().toISOString(),
    })
    .select()
    .single()

  if (error || !data) return { error: error?.message ?? "写入工具调用失败" }

  await supabase.from("agent_tasks").update({ updated_at: new Date().toISOString() }).eq("id", tc.taskId).eq("user_id", userId)

  return mapToolCall(data)
}

export async function completeToolCall(
  supabase: SupabaseClient,
  userId: string,
  toolCallId: string,
  result: {
    status: ToolCallStatus
    output?: Record<string, unknown>
    error?: string
  },
): Promise<AgentToolCall | { error: string }> {
  const finishedAt = new Date().toISOString()

  // 查 started_at 算 duration
  const { data: existing } = await supabase
    .from("agent_tool_calls")
    .select("started_at")
    .eq("id", toolCallId)
    .eq("user_id", userId)
    .single()

  let durationMs: number | null = null
  if (existing?.started_at) {
    durationMs = new Date(finishedAt).getTime() - new Date(existing.started_at).getTime()
  }

  const { error, data } = await supabase
    .from("agent_tool_calls")
    .update({
      status: result.status,
      output: result.output ?? null,
      error: result.error ?? null,
      finished_at: finishedAt,
      duration_ms: durationMs,
    })
    .eq("id", toolCallId)
    .eq("user_id", userId)
    .select()
    .single()

  if (error || !data) return { error: error?.message ?? "更新工具调用失败" }
  return mapToolCall(data)
}

// ───────────── Workspace ─────────────

export async function addWorkspace(
  supabase: SupabaseClient,
  userId: string,
  ws: {
    taskId: string
    repo: string
    branch?: string
    commitSha?: string
    path?: string
  },
): Promise<AgentWorkspace | { error: string }> {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()

  const { error, data } = await supabase
    .from("agent_workspaces")
    .upsert({
      id,
      task_id: ws.taskId,
      user_id: userId,
      repo: ws.repo,
      branch: ws.branch ?? "main",
      commit_sha: ws.commitSha ?? null,
      path: ws.path ?? null,
      status: "created",
      created_at: now,
      updated_at: now,
    }, { onConflict: "task_id" })
    .select()
    .single()

  if (error || !data) return { error: error?.message ?? "写入 workspace 失败" }
  return mapWorkspace(data)
}

// 更新 workspace 状态
export async function updateWorkspaceStatus(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
  status: WorkspaceStatus,
  extra?: { path?: string; commitSha?: string },
): Promise<AgentWorkspace | { error: string }> {
  const update: Record<string, unknown> = {
    status,
    updated_at: new Date().toISOString(),
  }
  if (extra?.path) update.path = extra.path
  if (extra?.commitSha) update.commit_sha = extra.commitSha

  const { error, data } = await supabase
    .from("agent_workspaces")
    .update(update)
    .eq("task_id", taskId)
    .eq("user_id", userId)
    .select()
    .single()

  if (error || !data) return { error: error?.message ?? "更新 workspace 失败" }
  return mapWorkspace(data)
}

// ───────────── 产物 ─────────────

export async function addArtifact(
  supabase: SupabaseClient,
  userId: string,
  art: {
    taskId: string
    kind: AgentArtifact["kind"]
    title?: string
    content?: string
    url?: string
    meta?: Record<string, unknown>
  },
): Promise<AgentArtifact | { error: string }> {
  const id = crypto.randomUUID()

  const { error, data } = await supabase
    .from("agent_artifacts")
    .insert({
      id,
      task_id: art.taskId,
      user_id: userId,
      kind: art.kind,
      title: art.title ?? null,
      content: art.content ?? null,
      url: art.url ?? null,
      meta: art.meta ?? null,
    })
    .select()
    .single()

  if (error || !data) return { error: error?.message ?? "写入产物失败" }
  return mapArtifact(data)
}
