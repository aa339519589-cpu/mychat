import { NextRequest } from "next/server"
import { enforceLimits, resolveAuth } from "@/lib/api/guard"
import { readJson, requestErrorResponse } from "@/lib/api/request"
import { clientMaestroTask, createMaestroTask, listMaestroTasks, type MaestroClientTask } from "@/lib/maestro/store"
import { maestroRunnerConfigured } from "@/lib/maestro/tokens"

const MAX_OBJECTIVE = 100_000

function directLaunchUrl(): string {
  const url = new URL("https://chatgpt.com/")
  url.searchParams.set("q", [
    "@My che che.",
    "这是 My Chat 刚创建的 Maestro Runner 任务。立刻调用 maestro_begin，参数必须是空对象 {}，然后直接开始执行任务。",
    "不要询问我任何启动码、token、任务 ID 或中转信息；这些都不是用户输入。",
    "每一轮真正结束前调用 maestro_round_gate，由 Runner 自动开启下一轮；独立 review 通过后才停止。",
  ].join("\n"))
  return url.toString()
}

export async function GET(request: Request): Promise<Response> {
  const auth = await resolveAuth(request)
  if (!auth.supabase || !auth.userId) return Response.json({ error: "请先登录" }, { status: 401 })
  try {
    const rows = await listMaestroTasks(auth.supabase, auth.userId)
    return Response.json({ tasks: rows.map(clientMaestroTask).filter((task): task is MaestroClientTask => task !== null) })
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
    const task = clientMaestroTask(row)
    if (!task) throw new Error("Maestro task metadata is invalid")
    return Response.json({ task, launchUrl: directLaunchUrl() }, { status: 201 })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Maestro 任务创建失败" }, { status: 500 })
  }
}
