// 权限确认系统：pendingConfirmation 存储在 task.meta
// confirm → 允许继续 + 清理 pendingConfirmation
// reject  → 不执行 + 清理 pendingConfirmation

import type { SupabaseClient } from "@supabase/supabase-js"
import type { RiskAssessment } from "./risk"
import { addStep, addArtifact, updateTaskStatus } from "./data"
import type { AgentTaskStatus } from "./types"
import { mergeTaskMeta } from "./meta"

// ─── 确认请求类型 ───

export type ConfirmationRequest = {
  id: string
  operation: string
  riskLevel: string
  title: string
  reason: string
  files: string[]
  createdAt: string
  status: "pending" | "confirmed" | "rejected"
  taskStatusAfterConfirm?: AgentTaskStatus
}

// ─── 创建确认请求 ───

export async function createConfirmationRequest(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
  risk: RiskAssessment,
  taskStatusAfterConfirm?: AgentTaskStatus,
): Promise<ConfirmationRequest> {
  const request: ConfirmationRequest = {
    id: crypto.randomUUID(),
    operation: risk.operation,
    riskLevel: risk.level,
    title: risk.title,
    reason: risk.reason,
    files: risk.files.slice(0, 20),
    createdAt: new Date().toISOString(),
    status: "pending",
    taskStatusAfterConfirm,
  }

  await mergeTaskMeta(supabase, userId, taskId, { pendingConfirmation: request })

  // 更新 task status
  await updateTaskStatus(supabase, userId, taskId, "waiting_for_user")

  // 写 step
  await addStep(supabase, userId, taskId, {
    kind: "confirm",
    label: `需要确认：${risk.title}`,
    detail: risk.reason,
  })

  // 写 artifact
  await addArtifact(supabase, userId, {
    taskId,
    kind: "summary",
    title: `Confirmation: ${risk.title}`,
    content: JSON.stringify({
      operation: risk.operation,
      riskLevel: risk.level,
      reason: risk.reason,
      files: risk.files.slice(0, 10),
    }),
    meta: {
      confirmationId: request.id,
      operation: risk.operation,
      riskLevel: risk.level,
      fileCount: risk.files.length,
    },
  })

  return request
}

// ─── 获取当前 pending confirmation ───

export async function getPendingConfirmation(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
): Promise<ConfirmationRequest | null> {
  const { data } = await supabase
    .from("agent_tasks")
    .select("meta")
    .eq("id", taskId)
    .eq("user_id", userId)
    .single()

  const meta = data?.meta as Record<string, unknown> | null
  const pending = meta?.pendingConfirmation as ConfirmationRequest | undefined
  if (pending && pending.status === "pending") return pending
  return null
}

export async function getConfirmation(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
): Promise<ConfirmationRequest | null> {
  const { data } = await supabase
    .from("agent_tasks")
    .select("meta")
    .eq("id", taskId)
    .eq("user_id", userId)
    .single()
  const meta = data?.meta as Record<string, unknown> | null
  return (meta?.pendingConfirmation as ConfirmationRequest | undefined) ?? null
}

type ResolutionResult = { ok: boolean; error?: string; request?: ConfirmationRequest }

async function resolveConfirmation(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
  confirmationId: string,
  status: "confirmed" | "rejected",
  reason?: string,
): Promise<ResolutionResult> {
  const pending = await getPendingConfirmation(supabase, userId, taskId)
  if (!pending) return { ok: false, error: "没有待确认的操作" }
  if (pending.id !== confirmationId) return { ok: false, error: "确认 ID 不匹配" }

  const request: ConfirmationRequest = { ...pending, status }
  await mergeTaskMeta(supabase, userId, taskId, { pendingConfirmation: request })

  const confirmed = status === "confirmed"
  await Promise.all([
    updateTaskStatus(supabase, userId, taskId, confirmed ? (pending.taskStatusAfterConfirm ?? "running") : "waiting_for_user"),
    addStep(supabase, userId, taskId, {
      kind: "confirm",
      label: confirmed ? "用户确认" : "用户拒绝",
      detail: `${confirmed ? "已确认" : "已拒绝"}：${pending.title}${reason ? `（${reason}）` : ""}`,
    }),
    addArtifact(supabase, userId, {
      taskId,
      kind: "summary",
      title: confirmed ? "Confirmed" : "Rejected",
      content: `用户${confirmed ? "确认" : "拒绝"}了操作：${pending.title}${reason ? ` — ${reason}` : ""}`,
      meta: { confirmationId, operation: pending.operation },
    }),
  ])

  return { ok: true, request }
}

export function confirmAgentOperation(
  supabase: SupabaseClient, userId: string, taskId: string, confirmationId: string,
): Promise<ResolutionResult> {
  return resolveConfirmation(supabase, userId, taskId, confirmationId, "confirmed")
}

export function rejectAgentOperation(
  supabase: SupabaseClient, userId: string, taskId: string, confirmationId: string, reason?: string,
): Promise<ResolutionResult> {
  return resolveConfirmation(supabase, userId, taskId, confirmationId, "rejected", reason)
}

// ─── 清理已完成的 confirmation ───

export async function clearConfirmation(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
): Promise<void> {
  await mergeTaskMeta(supabase, userId, taskId, {}, ["pendingConfirmation"])
}
