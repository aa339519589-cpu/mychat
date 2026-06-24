// POST /api/agent/tasks/[taskId]/workspace/exec — 在 workspace 内执行命令
import { NextRequest } from "next/server"
import { json } from "@/lib/api/response"
import { requireWorkspace } from "@/lib/agent/workspace-route"
import { runInWorkspace } from "@/lib/agent/shell"

export async function POST(req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params
  const ctx = await requireWorkspace(taskId)
  if ("error" in ctx) return ctx.error
  const body = await req.json().catch(() => null)
  if (!body?.command) return json({ error: "缺少 command" }, 400)

  const result = await runInWorkspace(ctx.supabase, ctx.userId, taskId, body.command, {
    cwd: body.cwd ?? undefined,
    timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : undefined,
  })

  if (result.blocked) return json(result, 400)

  return json(result)
}
