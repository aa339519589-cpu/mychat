import { NextRequest } from "next/server"
import { internalRecoveryToken, openRecoveryToken } from "@/lib/agent/recovery-token"
import { log } from "@/lib/logger"

export const runtime = "nodejs"

const STALE_AFTER_MS = 75_000
const activeRecoveries = new Set<string>()
const terminal = new Set(["waiting_for_user", "completed", "failed", "cancelled"])

export async function POST(req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params
  const payload = openRecoveryToken(req.headers.get("x-agent-resume") ?? "")
  if (!payload || payload.taskId !== taskId) return new Response(null, { status: 401 })
  if (activeRecoveries.has(taskId)) return new Response(null, { status: 204 })

  const origin = process.env.AGENT_PUBLIC_URL?.trim() || new URL(req.url).origin
  const detailResponse = await fetch(`${origin}/api/agent/tasks/${taskId}`, {
    headers: { cookie: payload.cookie },
    cache: "no-store",
  })
  if (!detailResponse.ok) {
    log.warn("agentRecovery", "Task session is unavailable", { taskId, status: detailResponse.status })
    return new Response(null, { status: 410 })
  }

  const task = await detailResponse.json() as {
    status?: string
    updatedAt?: string
    repo?: string
    meta?: { agentRun?: Record<string, any> }
  }
  if (!task.status || terminal.has(task.status)) return new Response(null, { status: 410 })
  const updatedAt = task.updatedAt ? new Date(task.updatedAt).getTime() : 0
  if (task.status === "running" && Date.now() - updatedAt < STALE_AFTER_MS) {
    return new Response(null, { status: 204 })
  }

  const run = task.meta?.agentRun
  if (!run?.repo || !Array.isArray(run.messages)) return new Response(null, { status: 410 })

  activeRecoveries.add(taskId)
  try {
    const response = await fetch(`${origin}/api/code/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: payload.cookie,
        "x-agent-recovery": internalRecoveryToken(),
      },
      body: JSON.stringify({
        repo: run.repo,
        tier: run.tier ?? "正构",
        messages: run.messages,
        resumeMessages: Array.isArray(run.resumeMessages) ? run.resumeMessages : undefined,
        responseId: run.responseId,
        sessionId: run.sessionId,
        taskId,
      }),
    })
    if (!response.ok) {
      const error = (await response.text()).slice(0, 500)
      log.error("agentRecovery", "Recovered Code run failed to start", { taskId, status: response.status, error })
      return new Response(JSON.stringify({ error }), { status: response.status })
    }
    if (response.body) {
      const reader = response.body.getReader()
      while (!(await reader.read()).done) { /* keep the recovered run alive */ }
    }
    return new Response(null, { status: 200 })
  } catch (error) {
    log.error("agentRecovery", "Recovery request failed", { taskId, error: String(error) })
    return new Response(null, { status: 500 })
  } finally {
    activeRecoveries.delete(taskId)
  }
}
