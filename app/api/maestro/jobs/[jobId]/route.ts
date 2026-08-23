import { NextRequest } from "next/server"
import { enforceRequestRateLimit, resolveAuth } from "@/lib/api/guard"
import { cancelMaestroTask, getMaestroTask, publicMaestroTask } from "@/lib/maestro/store"
import { isUuid } from "@/lib/validation"

async function target(request: NextRequest, context: { params: Promise<{ jobId: string }> }) {
  const auth = await resolveAuth(request)
  if (!auth.supabase || !auth.userId) return { response: Response.json({ error: "请先登录" }, { status: 401 }) } as const
  const { jobId } = await context.params
  if (!isUuid(jobId)) return { response: Response.json({ error: "任务 ID 无效" }, { status: 400 }) } as const
  return { auth, jobId } as const
}

export async function GET(request: NextRequest, context: { params: Promise<{ jobId: string }> }): Promise<Response> {
  const resolved = await target(request, context)
  if ("response" in resolved) return resolved.response
  try {
    const row = await getMaestroTask(resolved.auth.supabase, resolved.auth.userId, resolved.jobId)
    const task = row ? publicMaestroTask(row) : null
    return task ? Response.json({ task }) : Response.json({ error: "Maestro 任务不存在" }, { status: 404 })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Maestro 任务读取失败" }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ jobId: string }> }): Promise<Response> {
  const resolved = await target(request, context)
  if ("response" in resolved) return resolved.response
  const rate = await enforceRequestRateLimit(resolved.auth, request)
  if (rate.response) return rate.response
  try {
    const cancelled = await cancelMaestroTask(resolved.auth.supabase, resolved.auth.userId, resolved.jobId)
    return cancelled ? Response.json({ cancelled: true }) : Response.json({ error: "Maestro 任务不存在" }, { status: 404 })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Maestro 任务停止失败" }, { status: 500 })
  }
}
