import { NextRequest } from "next/server"
import { enforceLimits, resolveAuth } from "@/lib/api/guard"
import { readJson, requestErrorResponse } from "@/lib/api/request"
import { createMaestroTask, listMaestroTasks, publicMaestroTask, type MaestroPublicTask } from "@/lib/maestro/store"
import { maestroRunnerConfigured } from "@/lib/maestro/tokens"

const MAX_OBJECTIVE = 100_000

function startInstruction(task: MaestroPublicTask): string {
  return [
    "@Maestro Runner",
    `启动码：${task.startCode}`,
    "调用 maestro_start 读取这个 My Chat 任务。maestro_start 返回后结束当前回合。",
    "从下一回合开始直接执行任务；每一回合真正结束前必须调用 maestro_round_gate。之后由 Maestro Runner 界面自动创建下一回合，不需要我手动发送“继续”。",
    "只有独立 review 回合通过并且工具返回 finish 后才停止。",
  ].join("\n")
}

export async function GET(request: Request): Promise<Response> {
  const auth = await resolveAuth(request)
  if (!auth.supabase || !auth.userId) return Response.json({ error: "请先登录" }, { status: 401 })
  try {
    const rows = await listMaestroTasks(auth.supabase, auth.userId)
    return Response.json({ tasks: rows.map(publicMaestroTask).filter((task): task is MaestroPublicTask => task !== null) })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Maestro 任务读取失败" }, { status: 500 })
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  const auth = await resolveAuth(request)
  if (!auth.supabase || !auth.userId) return Response.json({ error: "请先登录" }, { status: 401 })
  const gate = await enforceLimits(auth, request, { quota: false })
  if (gate.response) return gate.response
  if (!maestroRunnerConfigured()) return Response.json({ error: "Maestro Runner 尚未完成服务器密钥配置" }, { status: 503 })

  let body: Record<string, unknown>
  try { body = await readJson(request, { maxBytes: 128 * 1024 }) }
  catch (error) { return requestErrorResponse(error) }

  const objective = typeof body.objective === "string" ? body.objective.trim() : ""
  const rawMaxRounds = body.maxRounds === undefined ? 10_000 : Number(body.maxRounds)
  if (!objective || objective.length > MAX_OBJECTIVE) return Response.json({ error: `任务内容必须为 1 到 ${MAX_OBJECTIVE} 个字符` }, { status: 400 })
  if (!Number.isSafeInteger(rawMaxRounds) || rawMaxRounds < 2 || rawMaxRounds > 100_000) {
    return Response.json({ error: "最大轮数必须是 2 到 100000 之间的整数" }, { status: 400 })
  }

  try {
    const row = await createMaestroTask(auth.supabase, auth.userId, objective, rawMaxRounds)
    const task = publicMaestroTask(row)
    if (!task) throw new Error("Maestro task metadata is invalid")
    return Response.json({ task, startInstruction: startInstruction(task) }, { status: 201 })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Maestro 任务创建失败" }, { status: 500 })
  }
}
