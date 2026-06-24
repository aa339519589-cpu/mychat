// GET /api/agent/tasks/[taskId]/workspace/diff — 获取 workspace 当前 diff 和变更文件列表

import { NextRequest } from "next/server"
import { json } from "@/lib/api/response"
import { requireWorkspace } from "@/lib/agent/workspace-route"
import { getWorkspaceDiff, getChangedFiles } from "@/lib/agent/workspace"
import { redactSensitive } from "@/lib/agent/path-security"

export async function GET(_req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params
  const ctx = await requireWorkspace(taskId)
  if ("error" in ctx) return ctx.error

  const diff = getWorkspaceDiff(taskId, ctx.userId)
  const changed = getChangedFiles(taskId, ctx.userId)

  return json({
    diff: redactSensitive(diff),
    changedFiles: changed.ok ? changed.data.files : [],
    summary: changed.ok ? changed.data.summary : { added: 0, modified: 0, deleted: 0 },
    hasChanges: diff.length > 0,
  })
}
