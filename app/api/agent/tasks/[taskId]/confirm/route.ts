// POST /api/agent/tasks/[taskId]/confirm — 确认或拒绝 pendingConfirmation
// body: { action: "confirm" | "reject", confirmationId?: string, reason?: string }

import { NextRequest } from "next/server"
import { resolveAuth } from "@/lib/api/guard"
import { json } from "@/lib/api/response"
import { confirmAgentOperation, rejectAgentOperation, getPendingConfirmation } from "@/lib/agent/permissions"

export async function POST(req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const auth = await resolveAuth()
  const supabase = auth.supabase
  const userId = auth.userId
  if (!supabase || !userId) return json({ error: "未登录" }, 401)

  const { taskId } = await params
  const body = await req.json().catch(() => ({}))
  const action = body?.action === "reject" ? "reject" : "confirm"
  const reason = typeof body?.reason === "string" ? body.reason : undefined

  if (action === "reject") {
    const result = await rejectAgentOperation(supabase, userId, taskId, body?.confirmationId ?? "", reason)
    if (!result.ok) return json(result, 400)
    return json(result.request)
  }

  const result = await confirmAgentOperation(supabase, userId, taskId, body?.confirmationId ?? "")
  if (!result.ok) return json(result, 400)
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
