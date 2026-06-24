// GET /api/agent/tasks/[taskId]/workspace/files — 列出 workspace 文件
import { NextRequest } from "next/server"
import { json } from "@/lib/api/response"
import { requireWorkspace } from "@/lib/agent/workspace-route"
import { listWorkspaceFiles } from "@/lib/agent/workspace"

export async function GET(_req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params
  const ctx = await requireWorkspace(taskId)
  if ("error" in ctx) return ctx.error

  const result = listWorkspaceFiles(taskId, ctx.userId)
  if (!result.ok) return json({ error: result.error }, 404)

  return json({ files: result.data.files, count: result.data.total, truncated: result.data.truncated })
}
