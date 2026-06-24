// 权限确认系统：pendingConfirmation 存储在 task.meta
// confirm → 允许继续 + 清理 pendingConfirmation
// reject  → 不执行 + 清理 pendingConfirmation

import type { SupabaseClient } from "@supabase/supabase-js"
import type { RiskAssessment } from "./risk"
import { addStep, addArtifact, updateTaskStatus } from "./data"

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
  taskStatusAfterConfirm?: string   // 确认后恢复到什么状态
}

export type ConfirmationResult = {
  confirmed: boolean
  rejectionReason?: string
}

// ─── 创建确认请求 ───

export async function createConfirmationRequest(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
  risk: RiskAssessment,
  taskStatusAfterConfirm?: string,
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

  // 写 meta
  const { data } = await supabase
    .from("agent_tasks")
    .select("meta")
    .eq("id", taskId)
    .eq("user_id", userId)
    .single()

  const existingMeta = (data?.meta ?? {}) as Record<string, unknown>
  await supabase
    .from("agent_tasks")
    .update({
      meta: { ...existingMeta, pendingConfirmation: request },
      updated_at: new Date().toISOString(),
    })
    .eq("id", taskId)
    .eq("user_id", userId)

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

// ─── 确认操作 ───

export async function confirmAgentOperation(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
  confirmationId: string,
): Promise<{ ok: boolean; error?: string; request?: ConfirmationRequest }> {
  const pending = await getPendingConfirmation(supabase, userId, taskId)
  if (!pending) return { ok: false, error: "没有待确认的操作" }
  if (pending.id !== confirmationId) return { ok: false, error: "确认 ID 不匹配" }

  // 更新 meta
  const { data } = await supabase
    .from("agent_tasks")
    .select("meta")
    .eq("id", taskId)
    .eq("user_id", userId)
    .single()

  const meta = (data?.meta ?? {}) as Record<string, unknown>
  meta.pendingConfirmation = { ...pending, status: "confirmed" }

  await supabase
    .from("agent_tasks")
    .update({ meta, updated_at: new Date().toISOString() })
    .eq("id", taskId)
    .eq("user_id", userId)

  // 恢复 task status
  const restoreStatus = pending.taskStatusAfterConfirm ?? "running"
  await updateTaskStatus(supabase, userId, taskId, restoreStatus)

  // 写 step
  await addStep(supabase, userId, taskId, {
    kind: "confirm",
    label: "用户确认",
    detail: `已确认：${pending.title}`,
  })

  // 写 artifact
  await addArtifact(supabase, userId, {
    taskId,
    kind: "summary",
    title: "Confirmed",
    content: `用户确认了操作：${pending.title}`,
    meta: { confirmationId, operation: pending.operation },
  })

  return { ok: true, request: { ...pending, status: "confirmed" } }
}

// ─── 拒绝操作 ───

export async function rejectAgentOperation(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
  confirmationId: string,
  reason?: string,
): Promise<{ ok: boolean; error?: string; request?: ConfirmationRequest }> {
  const pending = await getPendingConfirmation(supabase, userId, taskId)
  if (!pending) return { ok: false, error: "没有待确认的操作" }
  if (pending.id !== confirmationId) return { ok: false, error: "确认 ID 不匹配" }

  // 更新 meta
  const { data } = await supabase
    .from("agent_tasks")
    .select("meta")
    .eq("id", taskId)
    .eq("user_id", userId)
    .single()

  const meta = (data?.meta ?? {}) as Record<string, unknown>
  meta.pendingConfirmation = { ...pending, status: "rejected" }

  await supabase
    .from("agent_tasks")
    .update({ meta, updated_at: new Date().toISOString() })
    .eq("id", taskId)
    .eq("user_id", userId)

  // 保持 waiting_for_user（用户可以重新发起）
  await updateTaskStatus(supabase, userId, taskId, "waiting_for_user")

  // 写 step
  await addStep(supabase, userId, taskId, {
    kind: "confirm",
    label: "用户拒绝",
    detail: `已拒绝：${pending.title}${reason ? `（${reason}）` : ""}`,
  })

  await addArtifact(supabase, userId, {
    taskId,
    kind: "summary",
    title: "Rejected",
    content: `用户拒绝了操作：${pending.title}${reason ? ` — ${reason}` : ""}`,
    meta: { confirmationId, operation: pending.operation },
  })

  return { ok: true, request: { ...pending, status: "rejected" } }
}

// ─── 清理已完成的 confirmation ───

export async function clearConfirmation(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
): Promise<void> {
  const { data } = await supabase
    .from("agent_tasks")
    .select("meta")
    .eq("id", taskId)
    .eq("user_id", userId)
    .single()

  const meta = (data?.meta ?? {}) as Record<string, unknown>
  if (meta.pendingConfirmation) {
    delete meta.pendingConfirmation
    await supabase
      .from("agent_tasks")
      .update({ meta, updated_at: new Date().toISOString() })
      .eq("id", taskId)
      .eq("user_id", userId)
  }
}
