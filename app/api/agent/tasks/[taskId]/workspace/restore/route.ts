// POST /api/agent/tasks/[taskId]/workspace/restore — 恢复指定 snapshot

import { NextRequest } from "next/server"
import { json } from "@/lib/api/response"
import { addStep, addArtifact } from "@/lib/agent/data"
import { requireWorkspace } from "@/lib/agent/workspace-route"
import type { RestoreResult } from "@/lib/agent/types"
import {
  restoreWorkspaceSnapshot,
  revertLastWorkspaceChange,
} from "@/lib/agent/snapshot"
import { getWorkspaceDiff, getChangedFiles } from "@/lib/agent/workspace"

export async function POST(req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params
  const ctx = await requireWorkspace(taskId)
  if ("error" in ctx) return ctx.error

  let body: any = {}
  try { body = await req.json() } catch { /* optional */ }

  const snapshotId = typeof body.snapshotId === "string" ? body.snapshotId : null
  const useLast = body.useLast === true || !snapshotId

  let result: RestoreResult

  if (useLast) {
    result = await revertLastWorkspaceChange(taskId, ctx.userId, ctx.supabase)
  } else {
    result = await restoreWorkspaceSnapshot(taskId, ctx.userId, snapshotId!, ctx.supabase)
  }

  await addStep(ctx.supabase, ctx.userId, taskId, {
    kind: "tool_call",
    label: result.ok ? "恢复 snapshot" : "恢复失败",
    detail: result.ok
      ? `已恢复 ${result.restoredFiles} 个文件（来源: ${result.usedSource}）`
      : (result.error ?? "未知错误"),
  })

  if (result.ok) {
    const diff = getWorkspaceDiff(taskId, ctx.userId)
    const changed = getChangedFiles(taskId, ctx.userId)

    await addArtifact(ctx.supabase, ctx.userId, {
      taskId,
      kind: "diff",
      title: `Restore: ${result.usedSource}`,
      content: diff.slice(0, 10000),
      meta: {
        snapshotId: result.snapshotId,
        useLast,
        restoredFiles: result.restoredFiles,
        failedFiles: result.failedFiles,
        usedSource: result.usedSource,
        changedFiles: changed.ok ? changed.data.files : [],
      },
    })

    return json({
      ok: true,
      restoredFiles: result.restoredFiles,
      failedFiles: result.failedFiles,
      usedSource: result.usedSource,
      snapshotId: result.snapshotId,
      diff: diff.slice(0, 10000),
      changedFiles: changed.ok ? changed.data.files : [],
    })
  }

  return json(result, 400)
}
