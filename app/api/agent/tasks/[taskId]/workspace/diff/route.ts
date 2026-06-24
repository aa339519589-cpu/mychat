// GET /api/agent/tasks/[taskId]/workspace/diff — 获取 workspace 当前 diff 和变更文件列表

import { NextRequest } from "next/server"
import { resolveAuth } from "@/lib/api/guard"
import { getTaskDetail } from "@/lib/agent/data"
import { getWorkspaceDiff, getChangedFiles } from "@/lib/agent/workspace"
import { redactSensitive } from "@/lib/agent/path-security"

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } })
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params
  const auth = await resolveAuth()
  const supabase = auth.supabase
  const userId = auth.userId
  if (!supabase || !userId) return json({ error: "未登录" }, 401)

  const detail = await getTaskDetail(supabase, userId, taskId)
  if (!("workspace" in detail)) return json(detail, 404)

  const ws = detail.workspace
  if (!ws || (ws.status !== "ready" && ws.status !== "dirty")) return json({ error: "Workspace 未就绪" }, 400)

  const diff = getWorkspaceDiff(taskId, userId)
  const changed = getChangedFiles(taskId, userId)

  return json({
    diff: redactSensitive(diff),
    changedFiles: changed.ok ? changed.data.files : [],
    summary: changed.ok ? changed.data.summary : { added: 0, modified: 0, deleted: 0 },
    hasChanges: diff.length > 0,
  })
}
