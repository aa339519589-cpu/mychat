// POST /api/agent/tasks/[taskId]/workspace/exec — 在 workspace 内执行命令
import { NextRequest } from "next/server"
import { resolveAuth } from "@/lib/api/guard"
import { runInWorkspace } from "@/lib/agent/shell"

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const auth = await resolveAuth()
  if (!auth.supabase || !auth.userId) return json({ error: "未登录" }, 401)

  const { taskId } = await params
  const body = await req.json().catch(() => null)
  if (!body?.command) return json({ error: "缺少 command" }, 400)

  const result = await runInWorkspace(auth.supabase, auth.userId, taskId, body.command, {
    cwd: body.cwd ?? undefined,
    timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : undefined,
  })

  if (result.blocked) return json(result, 400)

  return json(result)
}
