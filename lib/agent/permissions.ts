import type { SupabaseClient } from "@supabase/supabase-js"

import { addArtifact, addStep } from "./data"
import {
  canonicalAgentOperationPlan,
  createAgentConfirmationToken,
  isAgentConfirmationOperation,
  sha256,
  type AgentConfirmationCredential,
  type AgentConfirmationOperation,
  type AgentOperationPlan,
} from "./confirmation-plan"
import type { RiskAssessment } from "./risk"
import type { AgentTaskStatus } from "./types"

export type ConfirmationRequest = {
  id: string
  taskId: string
  operation: AgentConfirmationOperation
  riskLevel: "high" | "critical"
  title: string
  reason: string
  files: string[]
  createdAt: string
  expiresAt: string
  approvedAt?: string | null
  rejectedAt?: string | null
  consumedAt?: string | null
  planHash: string
  status: "pending" | "approved" | "rejected" | "consumed" | "expired"
  confirmationToken?: string
}

type ResolutionResult = {
  ok: boolean
  error?: string
  reason?: string
  request?: ConfirmationRequest
}

type GateResult =
  | { allowed: true; request: ConfirmationRequest }
  | { allowed: false; status: number; error: string; request?: ConfirmationRequest }

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function parseConfirmation(value: unknown): ConfirmationRequest | null {
  if (!isRecord(value)
      || value.ok !== true
      || typeof value.id !== "string"
      || typeof value.taskId !== "string"
      || !isAgentConfirmationOperation(value.operation)
      || (value.riskLevel !== "high" && value.riskLevel !== "critical")
      || typeof value.title !== "string"
      || typeof value.reason !== "string"
      || !Array.isArray(value.files)
      || !value.files.every(file => typeof file === "string")
      || typeof value.createdAt !== "string"
      || typeof value.expiresAt !== "string"
      || typeof value.planHash !== "string"
      || !["pending", "approved", "rejected", "consumed", "expired"].includes(String(value.status))) {
    return null
  }
  return {
    id: value.id,
    taskId: value.taskId,
    operation: value.operation,
    riskLevel: value.riskLevel,
    title: value.title,
    reason: value.reason,
    files: value.files as string[],
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    approvedAt: typeof value.approvedAt === "string" ? value.approvedAt : null,
    rejectedAt: typeof value.rejectedAt === "string" ? value.rejectedAt : null,
    consumedAt: typeof value.consumedAt === "string" ? value.consumedAt : null,
    planHash: value.planHash,
    status: value.status as ConfirmationRequest["status"],
  }
}

function rpcReason(value: unknown): string | undefined {
  return isRecord(value) && typeof value.reason === "string" ? value.reason : undefined
}

function confirmationError(reason: string | undefined): { status: number; error: string } {
  switch (reason) {
    case "expired": return { status: 409, error: "确认已过期，请重新检查操作计划" }
    case "plan_mismatch": return { status: 409, error: "操作计划已变化，原确认已失效" }
    case "not_approved": return { status: 409, error: "该操作尚未获得用户确认" }
    case "already_consumed": return { status: 409, error: "确认令牌已被使用，不能重复执行" }
    case "invalid_confirmation": return { status: 403, error: "确认凭据无效或与操作不匹配" }
    default: return { status: 409, error: "确认状态已变化，请重新发起" }
  }
}

export async function createConfirmationRequest(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
  risk: RiskAssessment,
  plan: AgentOperationPlan,
  taskStatusAfterConfirm: AgentTaskStatus = "running",
): Promise<ConfirmationRequest> {
  if (!risk.needsConfirmation || risk.blocked || risk.level !== "high"
      || !isAgentConfirmationOperation(risk.operation)
      || plan.operation !== risk.operation
      || plan.userId !== userId || plan.taskId !== taskId) {
    throw new Error("无效的高风险确认计划")
  }
  const planCanonical = canonicalAgentOperationPlan(plan)
  const { token, tokenSha256 } = createAgentConfirmationToken()
  const { data, error } = await supabase.rpc("create_agent_confirmation_gate", {
    input_user_id: userId,
    input_task_id: taskId,
    input_operation: risk.operation,
    input_risk_level: risk.level,
    input_title: risk.title,
    input_reason: risk.reason,
    input_files: risk.files.slice(0, 100),
    input_plan_canonical: planCanonical,
    input_token_sha256: tokenSha256,
    input_resume_status: taskStatusAfterConfirm,
    input_ttl_seconds: 600,
  })
  if (error) throw new Error(`创建确认门失败：${error.message}`)
  const request = parseConfirmation(data)
  if (!request) throw new Error("确认门返回了无效结果")

  await Promise.all([
    addStep(supabase, userId, taskId, {
      kind: "confirm",
      label: `需要确认：${risk.title}`,
      detail: risk.reason,
    }),
    addArtifact(supabase, userId, {
      taskId,
      kind: "summary",
      title: `Confirmation: ${risk.title}`,
      content: JSON.stringify({
        operation: risk.operation,
        riskLevel: risk.level,
        reason: risk.reason,
        files: risk.files.slice(0, 10),
        planHash: request.planHash,
        expiresAt: request.expiresAt,
      }),
      meta: {
        confirmationId: request.id,
        operation: risk.operation,
        riskLevel: risk.level,
        fileCount: risk.files.length,
        planHash: request.planHash,
      },
    }),
  ])
  return { ...request, confirmationToken: token }
}

export async function getConfirmation(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
): Promise<ConfirmationRequest | null> {
  const { data, error } = await supabase.rpc("get_agent_confirmation_gate", {
    input_user_id: userId,
    input_task_id: taskId,
  })
  if (error) throw new Error(`读取确认门失败：${error.message}`)
  return data === null ? null : parseConfirmation(data)
}

export async function getPendingConfirmation(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
): Promise<ConfirmationRequest | null> {
  const request = await getConfirmation(supabase, userId, taskId)
  return request?.status === "pending" ? request : null
}

async function resolveConfirmation(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
  confirmationId: string,
  operation: AgentConfirmationOperation,
  confirmationToken: string,
  action: "confirm" | "reject",
  reason?: string,
): Promise<ResolutionResult> {
  const { data, error } = await supabase.rpc("resolve_agent_confirmation_gate", {
    input_user_id: userId,
    input_task_id: taskId,
    input_confirmation_id: confirmationId,
    input_operation: operation,
    input_token_sha256: sha256(confirmationToken),
    input_action: action,
    input_reason: reason ?? null,
  })
  if (error) return { ok: false, error: error.message }
  const request = parseConfirmation(data)
  if (!request) {
    const failure = confirmationError(rpcReason(data))
    return { ok: false, error: failure.error, reason: rpcReason(data) }
  }

  const confirmed = action === "confirm"
  await Promise.all([
    addStep(supabase, userId, taskId, {
      kind: "confirm",
      label: confirmed ? "用户确认" : "用户拒绝",
      detail: `${confirmed ? "已确认" : "已拒绝"}：${request.title}${reason ? `（${reason}）` : ""}`,
    }),
    addArtifact(supabase, userId, {
      taskId,
      kind: "summary",
      title: confirmed ? "Confirmed" : "Rejected",
      content: `用户${confirmed ? "确认" : "拒绝"}了操作：${request.title}${reason ? ` — ${reason}` : ""}`,
      meta: { confirmationId, operation, planHash: request.planHash },
    }),
  ])
  return { ok: true, request }
}

export function confirmAgentOperation(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
  confirmationId: string,
  operation: AgentConfirmationOperation,
  confirmationToken: string,
): Promise<ResolutionResult> {
  return resolveConfirmation(
    supabase, userId, taskId, confirmationId, operation, confirmationToken, "confirm",
  )
}

export function rejectAgentOperation(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
  confirmationId: string,
  operation: AgentConfirmationOperation,
  confirmationToken: string,
  reason?: string,
): Promise<ResolutionResult> {
  return resolveConfirmation(
    supabase, userId, taskId, confirmationId, operation, confirmationToken, "reject", reason,
  )
}

export async function requireAgentConfirmation(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
  risk: RiskAssessment,
  plan: AgentOperationPlan,
  credential: AgentConfirmationCredential | null,
  taskStatusAfterConfirm: AgentTaskStatus,
): Promise<GateResult> {
  if (!credential) {
    const request = await createConfirmationRequest(
      supabase, userId, taskId, risk, plan, taskStatusAfterConfirm,
    )
    return { allowed: false, status: 409, error: "高风险操作需要用户确认", request }
  }

  const planCanonical = canonicalAgentOperationPlan(plan)
  const { data, error } = await supabase.rpc("consume_agent_confirmation_gate", {
    input_user_id: userId,
    input_task_id: taskId,
    input_confirmation_id: credential.confirmationId,
    input_operation: risk.operation,
    input_plan_canonical: planCanonical,
    input_token_sha256: sha256(credential.confirmationToken),
  })
  if (error) return { allowed: false, status: 500, error: `消费确认门失败：${error.message}` }
  const request = parseConfirmation(data)
  if (!request || request.status !== "consumed") {
    const failure = confirmationError(rpcReason(data))
    return { allowed: false, ...failure }
  }
  return { allowed: true, request }
}
