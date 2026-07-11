// GET  /api/agent/tasks/[taskId]/workspace/git — git status
// POST /api/agent/tasks/[taskId]/workspace/git — publish (one-shot)

import { NextRequest } from "next/server"
import { json } from "@/lib/api/response"
import { requireWorkspace } from "@/lib/agent/workspace-route"
import {
  getWorkspaceGitStatus,
  publishWorkspaceToPullRequest,
} from "@/lib/agent/git-publish"
import { classifyPublishRisk } from "@/lib/agent/risk"
import { createConfirmationRequest, getConfirmation, clearConfirmation } from "@/lib/agent/permissions"
import { getGitHubSession } from "@/lib/github-session"
import { readJson, requestErrorResponse } from "@/lib/api/request"

async function getContext(taskId: string) {
  const ctx = await requireWorkspace(taskId)
  if ("error" in ctx) return ctx

  const session = await getGitHubSession()
  if (!session || session.userId !== ctx.userId) return { error: json({ error: "未连接 GitHub 或账号会话已变化" }, 401) }

  return { ...ctx, ghToken: session.token }
}

// ─── GET：git status ───
export async function GET(_req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params
  const ctx = await getContext(taskId)
  if ("error" in ctx) return ctx.error

  const status = getWorkspaceGitStatus(taskId, ctx.userId)
  return json(status)
}

// ─── POST：publish（commit → push → PR）───
export async function POST(req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params
  const ctx = await getContext(taskId)
  if ("error" in ctx) return ctx.error

  let body: Record<string, unknown> = {}
  try {
    body = await readJson(req, { maxBytes: 32 * 1024 })
  } catch (error) {
    if (req.headers.get("content-length") === "0" || !req.body) body = {}
    else return requestErrorResponse(error)
  }

  const action = body.action ?? "publish"

  if (action !== "publish") return json({ error: "不支持的 Git 操作" }, 400)

  // default: publish all — risk gate first
  if (action === "publish") {
    const status = getWorkspaceGitStatus(taskId, ctx.userId)
    const changedFiles = status.changedFiles?.map(f => f.path) ?? []
    const risk = classifyPublishRisk(changedFiles, status.currentBranch ?? "")

    if (risk.blocked) return json({ error: risk.reason, blocked: true }, 403)

    if (risk.needsConfirmation) {
      const existing = await getConfirmation(ctx.supabase, ctx.userId, taskId)
      if (existing?.status === "confirmed" && existing.operation === "publish") {
        await clearConfirmation(ctx.supabase, ctx.userId, taskId)
      } else if (existing?.status === "pending") {
        return json({ needsConfirmation: true, confirmationId: existing.id, risk }, 409)
      } else {
        if (existing) await clearConfirmation(ctx.supabase, ctx.userId, taskId)
        const req = await createConfirmationRequest(ctx.supabase, ctx.userId, taskId, risk, "creating_pr")
        return json({ needsConfirmation: true, confirmationId: req.id, risk }, 409)
      }
    }
  }

  const result = await publishWorkspaceToPullRequest(taskId, ctx.userId, ctx.ghToken, ctx.supabase, {
    message: typeof body.message === "string" ? body.message.slice(0, 500) : undefined,
    title: typeof body.title === "string" ? body.title.slice(0, 250) : undefined,
    body: typeof body.body === "string" ? body.body.slice(0, 20_000) : undefined,
  })

  if (!result.ok) return json(result, 400)
  return json(result)
}
