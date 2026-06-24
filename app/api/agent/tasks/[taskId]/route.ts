// GET  /api/agent/tasks/[taskId]  — 任务详情（含 steps / tool_calls / workspace / artifacts）
import { NextRequest } from "next/server"
import { resolveAuth } from "@/lib/api/guard"
import { getTaskDetail } from "@/lib/agent/data"

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } })
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const auth = await resolveAuth()
  if (!auth.supabase || !auth.userId) return json({ error: "未登录" }, 401)

  const { taskId } = await params
  if (!taskId) return json({ error: "缺少 taskId" }, 400)

  const detail = await getTaskDetail(auth.supabase, auth.userId, taskId)
  if (detail.error) return json(detail, 404)

  return json(detail)
}
