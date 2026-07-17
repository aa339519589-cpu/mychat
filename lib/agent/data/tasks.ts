import type { SupabaseClient } from "@/lib/supabase/types"
import type { AgentTask, AgentTaskDetail, AgentTaskStatus, CreateTaskInput } from "../types"
import { mapArtifact, mapStep, mapTask, mapToolCall, mapWorkspace } from "../data-mappers"
import type { TablesUpdate } from '@/lib/supabase/types'
import { toJson } from '@/lib/supabase/json'

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
      meta: input.meta ? toJson(input.meta) : null,
      created_at: now,
      updated_at: now,
    })
    .select()
    .single()

  if (error || !data) {
    console.error("[agent/data] createTask failed", {
      message: error?.message,
      code: error?.code,
      details: error?.details,
      hint: error?.hint,
      payload: {
        id,
        userId,
        goal: input.goal?.slice(0, 80),
        mode: input.mode ?? "auto",
        repo: input.repo,
      },
    })
    return { error: error?.message ?? "创建任务失败" }
  }
  return mapTask(data)
}

export async function listTasks(
  supabase: SupabaseClient,
  userId: string,
  opts?: { status?: string; repo?: string; limit?: number },
): Promise<AgentTask[]> {
  let query = supabase
    .from("agent_tasks")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(opts?.limit ?? 20)

  if (opts?.status) query = query.eq("status", opts.status)
  if (opts?.repo) query = query.eq("repo", opts.repo)

  const { data } = await query
  return (data ?? []).map(mapTask)
}

export async function getTaskDetail(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
): Promise<AgentTaskDetail | { error: string }> {
  const { data: task, error: taskError } = await supabase
    .from("agent_tasks")
    .select("*")
    .eq("id", taskId)
    .eq("user_id", userId)
    .single()

  if (taskError || !task) return { error: taskError?.message ?? "任务不存在" }

  const [steps, toolCalls, workspace, artifacts] = await Promise.all([
    supabase.from("agent_task_steps").select("*").eq("task_id", taskId).eq("user_id", userId).order("seq"),
    supabase.from("agent_tool_calls").select("*").eq("task_id", taskId).eq("user_id", userId).order("seq"),
    supabase.from("agent_workspaces").select("*").eq("task_id", taskId).eq("user_id", userId).limit(1),
    supabase.from("agent_artifacts").select("*").eq("task_id", taskId).eq("user_id", userId).order("created_at"),
  ])

  return {
    ...mapTask(task),
    steps: (steps.data ?? []).map(mapStep),
    toolCalls: (toolCalls.data ?? []).map(mapToolCall),
    workspace: workspace.data?.length ? mapWorkspace(workspace.data[0]) : null,
    artifacts: (artifacts.data ?? []).map(mapArtifact),
  }
}

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
  const update: TablesUpdate<'agent_tasks'> = {
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

export async function cancelTask(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
): Promise<AgentTask | { error: string }> {
  const { data } = await supabase
    .from("agent_tasks")
    .select("status")
    .eq("id", taskId)
    .eq("user_id", userId)
    .maybeSingle()
  if (!data) return { error: "任务不存在" }
  if (["completed", "failed", "cancelled"].includes(data.status)) {
    return { error: `当前状态 ${data.status} 不可取消` }
  }
  return updateTaskStatus(supabase, userId, taskId, "cancelled", {
    finishedAt: new Date().toISOString(),
  })
}

export async function resumeTask(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
): Promise<AgentTask | { error: string }> {
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
