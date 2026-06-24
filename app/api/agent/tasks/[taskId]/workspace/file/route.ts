// GET /api/agent/tasks/[taskId]/workspace/file?path=... — 读取 workspace 文件
import { NextRequest } from "next/server"
import { resolveAuth } from "@/lib/api/guard"
import { readWorkspaceFile } from "@/lib/agent/workspace"

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } })
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const auth = await resolveAuth()
  if (!auth.supabase || !auth.userId) return json({ error: "未登录" }, 401)

  const { taskId } = await params
  const url = new URL(req.url)
  const path = url.searchParams.get("path")
  if (!path) return json({ error: "缺少 path 参数" }, 400)

  // 校验归属
  const { data: task } = await auth.supabase
    .from("agent_tasks").select("id").eq("id", taskId).eq("user_id", auth.userId).single()
  if (!task) return json({ error: "任务不存在" }, 404)

  const result = await readWorkspaceFile(auth.userId, taskId, path)
  if ("error" in result) return json({ error: result.error }, 400)

  return json(result)
}
