import { NextRequest } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { applyMaestroReport, getMaestroTask, maestroMeta, type MaestroReportState } from "@/lib/maestro/store"
import { maestroStateHash, verifyMaestroReportToken, verifyMaestroTaskToken } from "@/lib/maestro/tokens"

const MAX_BODY_BYTES = 512 * 1024
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "cache-control": "no-store",
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: CORS })
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 64 && value.every(item => typeof item === "string")
}

function isReportState(value: unknown): value is MaestroReportState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return row.kind === "maestro-runner-state"
    && typeof row.jobId === "string"
    && typeof row.taskToken === "string" && row.taskToken.length <= 4_096
    && typeof row.objective === "string"
    && Number.isSafeInteger(row.round) && Number(row.round) >= 0
    && (row.phase === "work" || row.phase === "review" || row.phase === "done")
    && (row.action === "continue" || row.action === "review" || row.action === "finish" || row.action === "stop")
    && typeof row.checkpoint === "string" && row.checkpoint.length <= 36_000
    && isStrings(row.unresolved)
    && isStrings(row.nextActions)
    && isStrings(row.evidence)
    && typeof row.candidateAnswer === "string" && row.candidateAnswer.length <= 120_000
    && typeof row.finalAnswer === "string" && row.finalAnswer.length <= 120_000
    && typeof row.nextPrompt === "string" && row.nextPrompt.length <= 180_000
}

export async function POST(request: NextRequest): Promise<Response> {
  const length = Number(request.headers.get("content-length") ?? "0")
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) return json({ error: "report too large" }, 413)

  let body: Record<string, unknown>
  try {
    const raw = await request.text()
    if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return json({ error: "report too large" }, 413)
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return json({ error: "invalid report" }, 400)
    body = parsed as Record<string, unknown>
  } catch { return json({ error: "invalid JSON" }, 400) }

  const token = typeof body.token === "string" ? verifyMaestroReportToken(body.token) : null
  if (!token || !isReportState(body.state)) return json({ error: "invalid report token or state" }, 401)
  const state = body.state
  if (token.jobId !== state.jobId || token.round !== state.round || token.stateHash !== maestroStateHash(state)) {
    return json({ error: "report state does not match signed tool result" }, 403)
  }
  const taskAccess = verifyMaestroTaskToken(state.taskToken)
  if (!taskAccess || taskAccess.userId !== token.userId || taskAccess.jobId !== token.jobId) {
    return json({ error: "task access does not match report" }, 403)
  }

  const admin = createAdminClient()
  if (!admin) return json({ error: "Maestro storage unavailable" }, 503)
  try {
    const existing = await getMaestroTask(admin, token.userId, token.jobId)
    const meta = existing ? maestroMeta(existing) : null
    if (!existing || !meta || existing.goal !== state.objective) {
      return json({ error: "Maestro task mismatch" }, 403)
    }
    if (existing.status === "cancelled") return json({ ok: true, stop: true, status: "cancelled" })
    if (existing.status === "completed") return json({ ok: true, stop: true, status: "completed" })

    const task = await applyMaestroReport(admin, token.userId, token.jobId, state)
    const stop = task.status === "completed" || task.status === "cancelled" || state.action === "finish" || state.action === "stop"
    return json({ ok: true, stop, status: task.status, round: task.round, phase: task.phase })
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Maestro report failed" }, 409)
  }
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: CORS })
}
