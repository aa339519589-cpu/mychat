// POST /api/agent/tasks/[taskId]/workspace/cleanup — 清理 workspace
// 删除本地目录，保留 artifacts 和 task records

import { NextRequest } from "next/server"
import { resolveAuth } from "@/lib/api/guard"
import { getTaskDetail, addStep, updateWorkspaceStatus } from "@/lib/agent/data"
import { cleanupWorkspace } from "@/lib/agent/snapshot"

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } })
}

export async function POST(_req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params
  const auth = await resolveAuth()
  const supabase = auth.supabase
  const userId = auth.userId
  if (!supabase || !userId) return json({ error: "未登录" }, 401)

  const detail = await getTaskDetail(supabase, userId, taskId)
  if (!("workspace" in detail)) return json(detail, 404)

  const ws = detail.workspace
  if (!ws) return json({ error: "Workspace 不存在" }, 404)

  // 清理本地目录
  const result = cleanupWorkspace(taskId, userId)

  // 更新 DB 状态
  if (result.ok) {
    await updateWorkspaceStatus(supabase, userId, taskId, "cleaned")
  }

  await addStep(supabase, userId, taskId, {
    kind: "tool_call",
    label: result.ok ? "清理 workspace" : "清理失败",
    detail: result.ok ? "已删除本地 workspace 目录" : (result.error ?? "未知错误"),
  })

  if (result.ok) {
    return json({ ok: true, message: "Workspace 目录已清理，artifacts 和 task 记录保留" })
  }

  return json(result, 500)
}
