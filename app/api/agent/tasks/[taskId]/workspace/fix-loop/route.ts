// POST /api/agent/tasks/[taskId]/workspace/fix-loop — 运行有限轮 build/test/fix

import { NextRequest } from "next/server"
import { resolveAuth } from "@/lib/api/guard"
import { getTaskDetail, addStep } from "@/lib/agent/data"
import { runFixLoop } from "@/lib/agent/fix-loop"
import { applyWorkspacePatch, dryRunWorkspacePatch } from "@/lib/agent/patch"
import { editWorkspaceFile } from "@/lib/agent/workspace"
import { createWorkspaceSnapshot } from "@/lib/agent/snapshot"

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

  const maxRounds = typeof body.maxRounds === "number" ? Math.min(body.maxRounds, 3) : 2
  const steps = Array.isArray(body.steps) ? body.steps : undefined
  const autoFix = body.autoFix !== false // default true

  await addStep(supabase, userId, taskId, {
    kind: "tool_call",
    label: "启动 fix-loop",
    detail: `最多 ${maxRounds} 轮，自动修复: ${autoFix}`,
  })

  const result = await runFixLoop(taskId, userId, supabase, {
    maxRounds,
    steps,
    onFixNeeded: autoFix ? async (round, prompt, prevResult) => {
      // 当前 MVP：生成 prompt artifact，不自动调用模型
      // 后续可接入 Code Agent 的 chat completion API
      return null // 返回 null = 让前端/用户手动修复
    } : undefined,
  })

  return json(result)
}
