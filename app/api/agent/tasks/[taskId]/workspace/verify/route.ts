// POST /api/agent/tasks/[taskId]/workspace/verify — 运行 lint/typecheck/test/build

import { NextRequest } from "next/server"
import { json } from "@/lib/api/response"
import { addStep } from "@/lib/agent/data"
import { requireWorkspace } from "@/lib/agent/workspace-route"
import { runVerification } from "@/lib/agent/verify"

export async function POST(req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params
  const ctx = await requireWorkspace(taskId)
  if ("error" in ctx) return ctx.error

  let body: any = {}
  try { body = await req.json() } catch { /* defaults */ }

  const install = body.install === true
  const steps = Array.isArray(body.steps) ? body.steps : undefined

  await addStep(ctx.supabase, ctx.userId, taskId, {
    kind: "tool_call",
    label: "运行验证",
    detail: (steps ?? ["lint", "typecheck", "test", "build"]).join(", "),
  })

  const result = await runVerification(taskId, ctx.userId, ctx.supabase, { install, steps })

  return json(result)
}
