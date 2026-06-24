// POST /api/agent/tasks/[taskId]/workspace/snapshot — 手动创建 snapshot
// GET  /api/agent/tasks/[taskId]/workspace/snapshot — 列出 snapshots

import { NextRequest } from "next/server"
import { resolveAuth } from "@/lib/api/guard"
import { getTaskDetail, addStep, addArtifact } from "@/lib/agent/data"
import { createWorkspaceSnapshot, listWorkspaceSnapshots } from "@/lib/agent/snapshot"

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } })
}

async function getContext(taskId: string) {
  const auth = await resolveAuth()
  const supabase = auth.supabase
  const userId = auth.userId
  if (!supabase || !userId) return { error: json({ error: "未登录" }, 401) }

  const detail = await getTaskDetail(supabase, userId, taskId)
  if (!("workspace" in detail)) return { error: json(detail, 404) }

  const ws = detail.workspace
  if (!ws || (ws.status !== "ready" && ws.status !== "dirty")) return { error: json({ error: "Workspace 未就绪" }, 400) }

  return { supabase, userId, detail, ws }
}

// ─── POST：创建 snapshot ───
export async function POST(req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params
  const ctx = await getContext(taskId)
  if ("error" in ctx) return ctx.error

  let body: any = {}
  try { body = await req.json() } catch { /* optional */ }
  const reason = typeof body.reason === "string" ? body.reason : "手动 snapshot"

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
  const ctx = await getContext(taskId)
  if ("error" in ctx) return ctx.error

  const result = listWorkspaceSnapshots(taskId, ctx.userId)
  return json(result)
}
