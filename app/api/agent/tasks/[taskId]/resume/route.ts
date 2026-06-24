// POST /api/agent/tasks/[taskId]/resume — 恢复 failed/cancelled/waiting_for_user 任务
import { NextRequest } from "next/server"
import { resolveAuth } from "@/lib/api/guard"
import { resumeTask } from "@/lib/agent/data"

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } })
}

export async function POST(_req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const auth = await resolveAuth()
  if (!auth.supabase || !auth.userId) return json({ error: "未登录" }, 401)

  const { taskId } = await params
  const result = await resumeTask(auth.supabase, auth.userId, taskId)
  if (result.error) return json(result, 400)

  return json(result)
}
