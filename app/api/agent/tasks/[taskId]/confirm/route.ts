// POST /api/agent/tasks/[taskId]/confirm — 原子确认或拒绝数据库权威确认门
// body: { action, operation, confirmationId, confirmationToken, reason? }

import { NextRequest } from "next/server"
import { resolveAuth } from "@/lib/api/guard"
import { json } from "@/lib/api/response"
import { confirmAgentOperation, rejectAgentOperation, getPendingConfirmation } from "@/lib/agent/permissions"
import { isAgentConfirmationOperation, parseAgentConfirmationCredential } from "@/lib/agent/confirmation-plan"
import { readJson, requestErrorResponse } from "@/lib/api/request"
import { isRecord } from '@/lib/unknown-value'

export async function POST(req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const auth = await resolveAuth()
  const supabase = auth.supabase
  const userId = auth.userId
  if (!supabase || !userId) return json({ error: "未登录" }, 401)

  const { taskId } = await params
  let value: unknown
  try { value = await readJson(req, { maxBytes: 16 * 1024 }) } catch (error) { return requestErrorResponse(error) }
  const body = isRecord(value) ? value : {}
  if (body.action !== "confirm" && body.action !== "reject") {
    return json({ error: "action 必须严格为 confirm 或 reject" }, 400)
  }
  const action = body.action
  if (!isAgentConfirmationOperation(body.operation)) {
    return json({ error: "operation 无效" }, 400)
  }
  const reason = typeof body.reason === "string" ? body.reason.slice(0, 2000) : undefined
  let credential
  try { credential = parseAgentConfirmationCredential(body) } catch (error) {
    return json({ error: error instanceof Error ? error.message : "确认凭据无效" }, 400)
  }
  if (!credential) return json({ error: "缺少确认凭据" }, 400)

  if (action === "reject") {
    const result = await rejectAgentOperation(
      supabase, userId, taskId, credential.confirmationId,
      body.operation, credential.confirmationToken, reason,
    )
    if (!result.ok) return json(result, 409)
    return json(result.request)
  }

  const result = await confirmAgentOperation(
    supabase, userId, taskId, credential.confirmationId,
    body.operation, credential.confirmationToken,
  )
  if (!result.ok) return json(result, 409)
  return json(result.request)
}

// GET: 查询当前 pending confirmation
export async function GET(_req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const auth = await resolveAuth()
  const supabase = auth.supabase
  const userId = auth.userId
  if (!supabase || !userId) return json({ error: "未登录" }, 401)

  const { taskId } = await params
  const pending = await getPendingConfirmation(supabase, userId, taskId)
  return json(pending)
}
