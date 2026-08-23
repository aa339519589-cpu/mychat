import { NextRequest } from "next/server"
import { enforceRequestRateLimit, resolveAuth } from "@/lib/api/guard"
import { cancelMaestroTask, getMaestroTask, publicMaestroTask } from "@/lib/maestro/store"
import { isUuid } from "@/lib/validation"

export async function GET(request: NextRequest, context: { params: Promise<{ jobId: string }> }): Promise<Response> {
  const auth = await resolveAuth(request)
  if (!auth.supabase || !auth.userId) return Response.json({ error: "请先登录" }, { status: 401 })
  const { jobId } = await context.params
  if (!isUuid(jobId)) return Response.json({ error: "任务 ID 无效" }, { status: 400 })
  try {
    const row = await getMaestroTask(auth.supabase, auth.userId, jobId)
    const task = row ? publicMaestroTask(row) : null
    return task ? Response.json({ task }) : Response.json({ error: "Maestro 任务不存在" }, { status: 404 })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Maestro 任务读取失败" }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ jobId: string }> }): Promise<Response> {
  const auth = await resolveAuth(request)
  if (!auth.supabase || !auth.userId) return Response.json({ error: "请先登录" }, { status: 401 })
  const { jobId } = await context.params
  if (!isUuid(jobId)) return Response.json({ error: "任务 ID 无效" }, { status: 400 })
  const rate = await enforceRequestRateLimit(auth, request)
  if (rate.response) return rate.response
  try {
    const cancelled = await cancelMaestroTask(auth.supabase, auth.userId, jobId)
    return cancelled ? Response.json({ cancelled: true }) : Response.json({ error: "Maestro 任务不存在" }, { status: 404 })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Maestro 任务停止失败" }, { status: 500 })
  }
}
