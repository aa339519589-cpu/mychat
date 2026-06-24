// GET /api/agent/tasks/[taskId]/workspace/files — 列出 workspace 文件
import { NextRequest } from "next/server"
import { resolveAuth } from "@/lib/api/guard"
import { listWorkspaceFiles } from "@/lib/agent/workspace"

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } })
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const auth = await resolveAuth()
  if (!auth.supabase || !auth.userId) return json({ error: "未登录" }, 401)

  const { taskId } = await params

  // 校验归属
  const { data: task } = await auth.supabase
    .from("agent_tasks").select("id").eq("id", taskId).eq("user_id", auth.userId).single()
  if (!task) return json({ error: "任务不存在" }, 404)

  const result = listWorkspaceFiles(taskId, auth.userId)
  if (!result.ok) return json({ error: result.error }, 404)

  return json({ files: result.data.files, count: result.data.total, truncated: result.data.truncated })
}
