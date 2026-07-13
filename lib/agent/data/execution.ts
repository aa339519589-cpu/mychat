import type { SupabaseClient } from "@supabase/supabase-js"
import type { AgentTaskStep, AgentToolCall, StepKind, ToolCallStatus } from "../types"
import { mapStep, mapToolCall } from "../data-mappers"

async function touchTask(supabase: SupabaseClient, userId: string, taskId: string) {
  await supabase
    .from("agent_tasks")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", taskId)
    .eq("user_id", userId)
}

export async function addStep(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
  step: { kind: StepKind; label?: string; detail?: string },
): Promise<AgentTaskStep | { error: string }> {
  const { error, data } = await supabase
    .from("agent_task_steps")
    .insert({
      id: crypto.randomUUID(),
      task_id: taskId,
      user_id: userId,
      kind: step.kind,
      label: step.label ?? null,
      detail: step.detail ?? null,
    })
    .select()
    .single()

  if (error || !data) return { error: error?.message ?? "写入步骤失败" }
  await touchTask(supabase, userId, taskId)
  return mapStep(data)
}

export async function addToolCall(
  supabase: SupabaseClient,
  userId: string,
  toolCall: {
    taskId: string
    stepId?: string
    toolName: string
    input?: Record<string, unknown>
    status?: ToolCallStatus
  },
): Promise<AgentToolCall | { error: string }> {
  const { error, data } = await supabase
    .from("agent_tool_calls")
    .insert({
      id: crypto.randomUUID(),
      task_id: toolCall.taskId,
      user_id: userId,
      step_id: toolCall.stepId ?? null,
      tool_name: toolCall.toolName,
      input: toolCall.input ?? null,
      status: toolCall.status ?? "pending",
      started_at: new Date().toISOString(),
    })
    .select()
    .single()

  if (error || !data) return { error: error?.message ?? "写入工具调用失败" }
  await touchTask(supabase, userId, toolCall.taskId)
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
  const { data: existing } = await supabase
    .from("agent_tool_calls")
    .select("started_at")
    .eq("id", toolCallId)
    .eq("user_id", userId)
    .single()
  const durationMs = existing?.started_at
    ? new Date(finishedAt).getTime() - new Date(existing.started_at).getTime()
    : null

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
