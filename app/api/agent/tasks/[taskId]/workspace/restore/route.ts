// POST /api/agent/tasks/[taskId]/workspace/restore — 恢复指定 snapshot

import { NextRequest } from "next/server"
import { resolveAuth } from "@/lib/api/guard"
import { getTaskDetail, addStep, addArtifact } from "@/lib/agent/data"
import type { RestoreResult } from "@/lib/agent/types"
import {
  restoreWorkspaceSnapshot,
  revertLastWorkspaceChange,
  listWorkspaceSnapshots,
} from "@/lib/agent/snapshot"
import { getWorkspaceDiff, getChangedFiles } from "@/lib/agent/workspace"

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
  try { body = await req.json() } catch { /* optional */ }

  const snapshotId = typeof body.snapshotId === "string" ? body.snapshotId : null
  const useLast = body.useLast === true || !snapshotId

  let result: RestoreResult

  if (useLast) {
    result = await revertLastWorkspaceChange(taskId, userId, supabase)
  } else {
    result = await restoreWorkspaceSnapshot(taskId, userId, snapshotId!, supabase)
  }

  await addStep(supabase, userId, taskId, {
    kind: "tool_call",
    label: result.ok ? "恢复 snapshot" : "恢复失败",
    detail: result.ok
      ? `已恢复 ${result.restoredFiles} 个文件（来源: ${result.usedSource}）`
      : (result.error ?? "未知错误"),
  })

  if (result.ok) {
    const diff = getWorkspaceDiff(taskId, userId)
    const changed = getChangedFiles(taskId, userId)

    await addArtifact(supabase, userId, {
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
