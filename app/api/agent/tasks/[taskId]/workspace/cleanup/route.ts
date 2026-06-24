// POST /api/agent/tasks/[taskId]/workspace/cleanup — 清理 workspace
// 删除本地目录，保留 artifacts 和 task records

import { NextRequest } from "next/server"
import { json } from "@/lib/api/response"
import { addStep, updateWorkspaceStatus } from "@/lib/agent/data"
import { requireWorkspace } from "@/lib/agent/workspace-route"
import { cleanupWorkspace } from "@/lib/agent/snapshot"
import { cleanupIsolatedWorkspace } from "@/lib/agent/isolated-shell"

export async function POST(_req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params
  const ctx = await requireWorkspace(taskId, { ready: false })
  if ("error" in ctx) return ctx.error

  // 清理本地目录
  const result = cleanupWorkspace(taskId, ctx.userId)
  if (result.ok) await cleanupIsolatedWorkspace(ctx.supabase, ctx.userId, taskId)

  // 更新 DB 状态
  if (result.ok) {
    await updateWorkspaceStatus(ctx.supabase, ctx.userId, taskId, "cleaned")
  }

  await addStep(ctx.supabase, ctx.userId, taskId, {
    kind: "tool_call",
    label: result.ok ? "清理 workspace" : "清理失败",
    detail: result.ok ? "已删除本地 workspace 目录" : (result.error ?? "未知错误"),
  })

  if (result.ok) {
    return json({ ok: true, message: "Workspace 目录已清理，artifacts 和 task 记录保留" })
  }

  return json(result, 500)
}
