// GET  /api/agent/tasks/[taskId]/workspace/git — git status
// POST /api/agent/tasks/[taskId]/workspace/git — publish (one-shot)

import { NextRequest } from "next/server"
import { cookies } from "next/headers"
import { resolveAuth } from "@/lib/api/guard"
import { getTaskDetail, addStep, addArtifact, updateTaskStatus } from "@/lib/agent/data"
import {
  getWorkspaceGitStatus,
  commitWorkspaceChanges,
  pushAgentBranch,
  createWorkspacePullRequest,
  publishWorkspaceToPullRequest,
} from "@/lib/agent/git-publish"
import { classifyPublishRisk } from "@/lib/agent/risk"
import { createConfirmationRequest, getPendingConfirmation, clearConfirmation } from "@/lib/agent/permissions"

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
  if (!ws || (ws.status !== "ready" && ws.status !== "dirty")) {
    return { error: json({ error: "Workspace 未就绪" }, 400) }
  }

  const tokenStore = await cookies()
  const ghToken = tokenStore.get("gh_access_token")?.value
  if (!ghToken) return { error: json({ error: "未连接 GitHub" }, 401) }

  return { supabase, userId, detail, ws, ghToken }
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

  let body: any = {}
  try { body = await req.json() } catch { /* optional */ }

  const action = body.action ?? "publish"

  if (action === "commit") {
    const msg = body.message || `Agent: code changes`
    const result = await commitWorkspaceChanges(taskId, ctx.userId, msg, ctx.supabase)
    if (!result.ok) return json(result, 400)
    return json(result)
  }

  if (action === "push") {
    const result = await pushAgentBranch(taskId, ctx.userId, ctx.ghToken, ctx.supabase)
    if (!result.ok) return json(result, 400)
    return json(result)
  }

  if (action === "pr") {
    const result = await createWorkspacePullRequest(taskId, ctx.userId, ctx.ghToken, ctx.supabase, {
      title: body.title,
      body: body.body,
      base: body.base,
    })
    if (!result.ok) return json(result, 400)
    return json(result)
  }

  // default: publish all — risk gate first
  if (action === "publish") {
    const status = getWorkspaceGitStatus(taskId, ctx.userId)
    const changedFiles = status.changedFiles?.map(f => f.path) ?? []
    const risk = classifyPublishRisk(changedFiles, status.currentBranch ?? "")

    if (risk.blocked) return json({ error: risk.reason, blocked: true }, 403)

    if (risk.needsConfirmation) {
      const existing = await getPendingConfirmation(ctx.supabase, ctx.userId, taskId)
      if (existing?.status === "confirmed" && existing.operation === "publish") {
        await clearConfirmation(ctx.supabase, ctx.userId, taskId)
      } else if (!existing) {
        const req = await createConfirmationRequest(ctx.supabase, ctx.userId, taskId, risk, "creating_pr")
        return json({ needsConfirmation: true, confirmationId: req.id, risk }, 409)
      }
    }
  }

  const result = await publishWorkspaceToPullRequest(taskId, ctx.userId, ctx.ghToken, ctx.supabase, {
    message: body.message,
    title: body.title,
    body: body.body,
    base: body.base,
  })

  if (!result.ok) return json(result, 400)
  return json(result)
}
