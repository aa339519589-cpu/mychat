// GET /api/agent/tasks/[taskId]/workspace/commands — 项目命令检测

import { NextRequest } from "next/server"
import { resolveAuth } from "@/lib/api/guard"
import { getTaskDetail } from "@/lib/agent/data"
import { detectProjectCommands } from "@/lib/agent/project-detect"

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } })
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params
  const auth = await resolveAuth()
  const supabase = auth.supabase
  const userId = auth.userId
  if (!supabase || !userId) return json({ error: "未登录" }, 401)

  const detail = await getTaskDetail(supabase, userId, taskId)
  if (!("workspace" in detail)) return json(detail, 404)

  const ws = detail.workspace
  if (!ws || (ws.status !== "ready" && ws.status !== "dirty")) return json({ error: "Workspace 未就绪" }, 400)

  const detected = detectProjectCommands(taskId, userId)
  return json(detected)
}
