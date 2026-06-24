// POST /api/agent/tasks/[taskId]/workspace/patch — dry-run 或 apply unified diff

import { NextRequest } from "next/server"
import { resolveAuth } from "@/lib/api/guard"
import { getTaskDetail, addStep, addArtifact } from "@/lib/agent/data"
import { dryRunWorkspacePatch, applyWorkspacePatch } from "@/lib/agent/patch"
import { getChangedFiles } from "@/lib/agent/workspace"

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
  try { body = await req.json() } catch { return json({ error: "请求体格式错误" }, 400) }

  const { patch, dryRun = false } = body
  if (!patch || typeof patch !== "string") return json({ error: "缺少 patch 内容" }, 400)
  if (patch.length > 4 * 1024 * 1024) return json({ error: "Patch 过大（>4MB）" }, 400)

  if (dryRun) {
    const result = dryRunWorkspacePatch(taskId, userId, patch)

    await addStep(supabase, userId, taskId, {
      kind: "tool_call",
      label: "apply_patch (dry-run)",
      detail: result.ok ? `检查通过：${result.changedFiles.length} 个文件` : result.error,
    })

    return json(result)
  }

  // 实际 apply
  const result = await applyWorkspacePatch(taskId, userId, patch, { supabase })

  await addStep(supabase, userId, taskId, {
    kind: "tool_call",
    label: result.ok ? `apply_patch` : `apply_patch 失败`,
    detail: result.ok ? `${result.changedFiles.length} 个文件已修改` : result.error,
  })

  if (result.ok) {
    const changed = getChangedFiles(taskId, userId)
    await addArtifact(supabase, userId, {
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
