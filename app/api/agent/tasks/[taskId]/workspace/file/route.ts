// POST   /api/agent/tasks/[taskId]/workspace/file — 写文件
// PATCH  /api/agent/tasks/[taskId]/workspace/file — 编辑文件（old_string 替换）
// DELETE /api/agent/tasks/[taskId]/workspace/file — 删除文件

import { NextRequest } from "next/server"
import type { SupabaseClient } from "@supabase/supabase-js"
import { json } from "@/lib/api/response"
import { addStep, addArtifact } from "@/lib/agent/data"
import { requireWorkspace } from "@/lib/agent/workspace-route"
import {
  writeWorkspaceFile,
  editWorkspaceFile,
  deleteWorkspaceFile,
  getChangedFiles,
} from "@/lib/agent/workspace"
import { classifyAgentRisk } from "@/lib/agent/risk"
import { createConfirmationRequest, getConfirmation, clearConfirmation } from "@/lib/agent/permissions"
import { readJson, requestErrorResponse } from "@/lib/api/request"

// 风险门禁：如果操作需要确认，创建 confirmation 并返回 waiting_for_user
async function riskGate(
  supabase: SupabaseClient, userId: string, taskId: string,
  operation: "write_file" | "edit_file" | "delete_files",
  files: string[], fileCount?: number,
): Promise<Response | null> {
  const risk = classifyAgentRisk(operation, { files, fileCount })
  if (risk.blocked) {
    return json({ error: risk.reason, blocked: true }, 403)
  }
  if (risk.needsConfirmation) {
    // 检查是否已有已确认的请求（针对同一操作）
    const existing = await getConfirmation(supabase, userId, taskId)
    if (existing) {
      if (existing.status === "confirmed" && existing.operation === operation) {
        await clearConfirmation(supabase, userId, taskId)
        return null // 已确认，放行
      }
      if (existing.status === "pending") {
        return json({ needsConfirmation: true, confirmationId: existing.id, risk }, 409)
      }
      await clearConfirmation(supabase, userId, taskId)
    }
    const req = await createConfirmationRequest(supabase, userId, taskId, risk, "editing")
    return json({ needsConfirmation: true, confirmationId: req.id, risk }, 409)
  }
  return null
}

// ─── POST：写文件 ───
export async function POST(req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params
  const ctx = await requireWorkspace(taskId, { path: true })
  if ("error" in ctx) return ctx.error

  let body: any
  try { body = await readJson(req, { maxBytes: 3 * 1024 * 1024 }) } catch (error) { return requestErrorResponse(error) }

  const { path, content } = body
  if (!path || typeof path !== "string") return json({ error: "缺少 path" }, 400)
  if (typeof content !== "string") return json({ error: "缺少 content" }, 400)

  const gate = await riskGate(ctx.supabase, ctx.userId, taskId, "write_file", [path])
  if (gate) return gate

  const result = await writeWorkspaceFile(taskId, ctx.userId, path, content, ctx.supabase)

  await addStep(ctx.supabase, ctx.userId, taskId, {
    kind: "tool_call",
    label: result.ok ? `写入 ${path}` : `写入失败`,
    detail: result.ok ? `${content.length} 字符` : result.error,
  })

  if (result.ok) {
    const changed = getChangedFiles(taskId, ctx.userId)
    await addArtifact(ctx.supabase, ctx.userId, {
      taskId,
      kind: "diff",
      title: `写入 ${path}`,
      content: result.data.diff.slice(0, 10000),
      meta: {
        path, size: content.length,
        changedFiles: changed.ok ? changed.data.files : [],
        snapshotId: result.data.snapshotId,
        operation: "write",
      },
    })
    return json(result.data)
  }

  return json(result, 400)
}

// ─── PATCH：编辑文件 ───
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params
  const ctx = await requireWorkspace(taskId, { path: true })
  if ("error" in ctx) return ctx.error

  let body: any
  try { body = await readJson(req, { maxBytes: 3 * 1024 * 1024 }) } catch (error) { return requestErrorResponse(error) }

  const { path, old_string, new_string } = body
  if (!path || typeof path !== "string") return json({ error: "缺少 path" }, 400)
  if (typeof old_string !== "string" || !old_string) return json({ error: "缺少 old_string" }, 400)
  if (typeof new_string !== "string") return json({ error: "缺少 new_string" }, 400)

  const editGate = await riskGate(ctx.supabase, ctx.userId, taskId, "edit_file", [path])
  if (editGate) return editGate

  const result = await editWorkspaceFile(taskId, ctx.userId, path, old_string, new_string, ctx.supabase)

  await addStep(ctx.supabase, ctx.userId, taskId, {
    kind: "tool_call",
    label: result.ok ? `编辑 ${path}` : `编辑失败`,
    detail: result.ok ? "替换 1 处" : result.error,
  })

  if (result.ok) {
    const changed = getChangedFiles(taskId, ctx.userId)
    await addArtifact(ctx.supabase, ctx.userId, {
      taskId,
      kind: "diff",
      title: `编辑 ${path}`,
      content: result.data.diff.slice(0, 10000),
      meta: {
        path, changedFiles: changed.ok ? changed.data.files : [],
        snapshotId: result.data.snapshotId,
        operation: "edit",
      },
    })
    return json(result.data)
  }

  return json(result, 400)
}

// ─── DELETE：删除文件 ───
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params
  const ctx = await requireWorkspace(taskId, { path: true })
  if ("error" in ctx) return ctx.error

  const url = new URL(req.url)
  const path = url.searchParams.get("path")
  if (!path) return json({ error: "缺少 path 参数" }, 400)

  const delGate = await riskGate(ctx.supabase, ctx.userId, taskId, "delete_files", [path])
  if (delGate) return delGate

  const result = await deleteWorkspaceFile(taskId, ctx.userId, path, ctx.supabase)

  await addStep(ctx.supabase, ctx.userId, taskId, {
    kind: "tool_call",
    label: result.ok ? `删除 ${path}` : `删除失败`,
    detail: result.ok ? "已删除" : result.error,
  })

  if (result.ok) {
    const changed = getChangedFiles(taskId, ctx.userId)
    await addArtifact(ctx.supabase, ctx.userId, {
      taskId,
      kind: "diff",
      title: `删除 ${path}`,
      content: result.data.diff.slice(0, 10000),
      meta: {
        path, changedFiles: changed.ok ? changed.data.files : [],
        snapshotId: result.data.snapshotId,
        operation: "delete",
      },
    })
    return json(result.data)
  }

  return json(result, 400)
}
