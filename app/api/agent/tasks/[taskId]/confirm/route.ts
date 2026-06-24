// POST /api/agent/tasks/[taskId]/confirm — 用户确认/拒绝操作
import { NextRequest } from "next/server"
import { resolveAuth } from "@/lib/api/guard"
import { addConfirmRecord } from "@/lib/agent/data"

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const auth = await resolveAuth()
  if (!auth.supabase || !auth.userId) return json({ error: "未登录" }, 401)

  const { taskId } = await params
  const body = await req.json().catch(() => null)
  const confirmed = body?.confirmed === true
  const reason = typeof body?.reason === "string" ? body.reason : undefined

  const result = await addConfirmRecord(auth.supabase, auth.userId, taskId, confirmed, reason)
  if ("error" in result) return json(result, 500)

  return json(result, 201)
}
