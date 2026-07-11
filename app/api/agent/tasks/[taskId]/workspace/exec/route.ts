// POST /api/agent/tasks/[taskId]/workspace/exec — 在 workspace 内执行命令
import { NextRequest } from "next/server"
import { json } from "@/lib/api/response"
import { requireWorkspace } from "@/lib/agent/workspace-route"
import { runInWorkspace } from "@/lib/agent/shell"
import { readJson, requestErrorResponse } from "@/lib/api/request"

export async function POST(req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params
  const ctx = await requireWorkspace(taskId)
  if ("error" in ctx) return ctx.error
  let body: any
  try { body = await readJson(req, { maxBytes: 64 * 1024 }) } catch (error) { return requestErrorResponse(error) }
  if (!body?.command) return json({ error: "缺少 command" }, 400)
  if (typeof body.command !== "string" || body.command.length > 10_000) return json({ error: "command 格式无效或过长" }, 400)
  if (body.cwd !== undefined && (typeof body.cwd !== "string" || body.cwd.length > 500)) return json({ error: "cwd 格式无效" }, 400)

  const result = await runInWorkspace(ctx.supabase, ctx.userId, taskId, body.command, {
    cwd: body.cwd ?? undefined,
    timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : undefined,
  })

  if (result.blocked) return json(result, 400)

  return json(result)
}
