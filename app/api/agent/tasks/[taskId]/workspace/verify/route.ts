// POST /api/agent/tasks/[taskId]/workspace/verify — 运行 lint/typecheck/test/build

import { NextRequest } from "next/server"
import { json } from "@/lib/api/response"
import { addStep } from "@/lib/agent/data"
import { requireWorkspace } from "@/lib/agent/workspace-route"
import { runVerification } from "@/lib/agent/verify"
import { isolatedShellConfigured } from "@/lib/agent/isolated-shell"
import { localWorkspaceExecutionAllowed } from "@/lib/agent/shell"
import { readJson, requestErrorResponse } from "@/lib/api/request"

const VERIFY_STEPS = new Set(["lint", "typecheck", "test", "build"] as const)

export async function POST(req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params
  const ctx = await requireWorkspace(taskId)
  if ("error" in ctx) return ctx.error

  let body: Record<string, unknown> = {}
  try {
    body = await readJson(req, { maxBytes: 8 * 1024 })
  } catch (error) {
    if (req.headers.get("content-length") === "0" || !req.body) body = {}
    else return requestErrorResponse(error)
  }

  if (!isolatedShellConfigured() && !localWorkspaceExecutionAllowed()) {
    return json({ error: "命令执行未配置；生产环境必须设置 E2B_API_KEY" }, 503)
  }

  const install = body.install === true
  const requestedSteps = Array.isArray(body.steps) ? body.steps : undefined
  if (requestedSteps?.some(step => typeof step !== "string" || !VERIFY_STEPS.has(step as never))) {
    return json({ error: "steps 只能包含 lint、typecheck、test、build" }, 400)
  }
  const steps = requestedSteps as ("lint" | "typecheck" | "test" | "build")[] | undefined

  await addStep(ctx.supabase, ctx.userId, taskId, {
    kind: "tool_call",
    label: "运行验证",
    detail: (steps ?? ["lint", "typecheck", "test", "build"]).join(", "),
  })

  const result = await runVerification(taskId, ctx.userId, ctx.supabase, { install, steps })

  return json(result)
}
