// POST /api/agent/tasks/[taskId]/workspace/snapshot — 手动创建 snapshot
// GET  /api/agent/tasks/[taskId]/workspace/snapshot — 列出 snapshots

import { NextRequest } from "next/server"
import { json } from "@/lib/api/response"
import { addStep, addArtifact } from "@/lib/agent/data"
import { requireWorkspace } from "@/lib/agent/workspace-route"
import { createWorkspaceSnapshot, listWorkspaceSnapshots } from "@/lib/agent/snapshot"
import { readJson, requestErrorResponse } from "@/lib/api/request"

// ─── POST：创建 snapshot ───
export async function POST(req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params
  const ctx = await requireWorkspace(taskId)
  if ("error" in ctx) return ctx.error

  let body: Record<string, unknown> = {}
  try {
    body = await readJson(req, { maxBytes: 8 * 1024 })
  } catch (error) {
    if (req.headers.get("content-length") === "0" || !req.body) body = {}
    else return requestErrorResponse(error)
  }
  const reason = typeof body.reason === "string"
    ? body.reason.trim().slice(0, 300) || "手动 snapshot"
    : "手动 snapshot"

  const result = await createWorkspaceSnapshot(taskId, ctx.userId, reason, ctx.supabase)

  await addStep(ctx.supabase, ctx.userId, taskId, {
    kind: "tool_call",
    label: result.ok ? "创建 snapshot" : "snapshot 失败",
    detail: result.ok ? `${result.snapshot.changedFiles.length} 个文件` : result.error,
  })

  if (result.ok) {
    await addArtifact(ctx.supabase, ctx.userId, {
      taskId,
      kind: "summary",
      title: `Snapshot: ${reason}`,
      content: `Snapshot ID: ${result.snapshot.snapshotId}\nFile count: ${result.snapshot.changedFiles.length}`,
      meta: { snapshotId: result.snapshot.snapshotId, reason, fileCount: result.snapshot.changedFiles.length },
    })
    return json(result.snapshot)
  }

  return json(result, 400)
}

// ─── GET：列出 snapshots ───
export async function GET(_req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params
  const ctx = await requireWorkspace(taskId)
  if ("error" in ctx) return ctx.error

  const result = await listWorkspaceSnapshots(taskId, ctx.userId, ctx.supabase)
  return json(result)
}
