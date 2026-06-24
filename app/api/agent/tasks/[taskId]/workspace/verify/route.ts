// POST /api/agent/tasks/[taskId]/workspace/verify — 运行 lint/typecheck/test/build

import { NextRequest } from "next/server"
import { resolveAuth } from "@/lib/api/guard"
import { getTaskDetail, addStep } from "@/lib/agent/data"
import { runVerification } from "@/lib/agent/verify"

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params
  const auth = await resolveAuth()
  const supabase = auth.supabase
  const userId = auth.userId
  if (!supabase || !userId) return json({ error: "未登录" }, 401)

  const detail = await getTaskDetail(supabase, userId, taskId)
  if (!("workspace" in detail)) return json(detail, 404)

  const ws = detail.workspace
  if (!ws || (ws.status !== "ready" && ws.status !== "dirty")) return json({ error: "Workspace 未就绪" }, 400)

  let body: any = {}
  try { body = await req.json() } catch { /* defaults */ }

  const install = body.install === true
  const steps = Array.isArray(body.steps) ? body.steps : undefined

  await addStep(supabase, userId, taskId, {
    kind: "tool_call",
    label: "运行验证",
    detail: (steps ?? ["lint", "typecheck", "test", "build"]).join(", "),
  })

  const result = await runVerification(taskId, userId, supabase, { install, steps })

  return json(result)
}
