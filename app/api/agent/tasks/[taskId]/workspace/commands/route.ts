// GET /api/agent/tasks/[taskId]/workspace/commands — 项目命令检测

import { NextRequest } from "next/server"
import { json } from "@/lib/api/response"
import { requireWorkspace } from "@/lib/agent/workspace-route"
import { detectProjectCommands } from "@/lib/agent/project-detect"

export async function GET(_req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params
  const ctx = await requireWorkspace(taskId)
  if ("error" in ctx) return ctx.error

  const detected = detectProjectCommands(taskId, ctx.userId)
  return json(detected)
}
