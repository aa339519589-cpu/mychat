// POST /api/agent/tasks/[taskId]/workspace/patch — dry-run 或 apply unified diff

import { NextRequest } from "next/server"
import { json } from "@/lib/api/response"
import { addStep, addArtifact } from "@/lib/agent/data"
import { requireWorkspace } from "@/lib/agent/workspace-route"
import { dryRunWorkspacePatch, applyWorkspacePatch } from "@/lib/agent/patch"
import { getChangedFiles } from "@/lib/agent/workspace"
import { readJson, requestErrorResponse } from "@/lib/api/request"

export async function POST(req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params
  const ctx = await requireWorkspace(taskId)
  if ("error" in ctx) return ctx.error

  let body: any
  try { body = await readJson(req, { maxBytes: 4 * 1024 * 1024 + 4096 }) } catch (error) { return requestErrorResponse(error) }

  const { patch, dryRun = false } = body
  if (!patch || typeof patch !== "string") return json({ error: "缺少 patch 内容" }, 400)
  if (patch.length > 4 * 1024 * 1024) return json({ error: "Patch 过大（>4MB）" }, 400)

  if (dryRun) {
    const result = dryRunWorkspacePatch(taskId, ctx.userId, patch)

    await addStep(ctx.supabase, ctx.userId, taskId, {
      kind: "tool_call",
      label: "apply_patch (dry-run)",
      detail: result.ok ? `检查通过：${result.changedFiles.length} 个文件` : result.error,
    })

    return json(result)
  }

  // 实际 apply
  const result = await applyWorkspacePatch(taskId, ctx.userId, patch, { supabase: ctx.supabase })

  await addStep(ctx.supabase, ctx.userId, taskId, {
    kind: "tool_call",
    label: result.ok ? `apply_patch` : `apply_patch 失败`,
    detail: result.ok ? `${result.changedFiles.length} 个文件已修改` : result.error,
  })

  if (result.ok) {
    const changed = getChangedFiles(taskId, ctx.userId)
    await addArtifact(ctx.supabase, ctx.userId, {
      taskId,
      kind: "diff",
      title: "Apply patch",
      content: result.diffSummary.slice(0, 10000),
      meta: {
        changedFiles: result.changedFiles,
        fileCount: result.changedFiles.length,
        summary: changed.ok ? changed.data.summary : {},
      },
    })
    return json(result)
  }

  return json(result, 400)
}
