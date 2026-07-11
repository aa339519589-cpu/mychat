// POST  /api/agent/tasks     — 创建任务
// GET   /api/agent/tasks     — 查询任务列表
import { NextRequest } from "next/server"
import { resolveAuth } from "@/lib/api/guard"
import { json } from "@/lib/api/response"
import { createTask, listTasks } from "@/lib/agent/data"
import type { CreateTaskInput } from "@/lib/agent/types"
import { readJson, requestErrorResponse } from "@/lib/api/request"

export async function POST(req: NextRequest) {
  const auth = await resolveAuth()
  if (!auth.supabase || !auth.userId) return json({ error: "未登录" }, 401)

  let body: CreateTaskInput
  try { body = await readJson<CreateTaskInput>(req, { maxBytes: 64 * 1024 }) } catch (error) { return requestErrorResponse(error) }
  if (typeof body?.goal !== "string" || !body.goal.trim() || body.goal.length > 10_000) return json({ error: "goal 缺失或过长" }, 400)
  if (body.repo !== undefined && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(body.repo)) return json({ error: "repo 格式无效" }, 400)
  if (body.mode !== undefined && !["auto", "confirm", "plan", "pr"].includes(body.mode)) return json({ error: "mode 无效" }, 400)

  const result = await createTask(auth.supabase, auth.userId, body)
  if (result.error) {
    console.error('[agent/tasks] createTask failed', { error: result.error, goal: body.goal?.slice(0, 80), repo: body.repo })
    return json(result, 500)
  }

  return json(result, 201)
}

export async function GET(req: NextRequest) {
  const auth = await resolveAuth()
  if (!auth.supabase || !auth.userId) return json({ error: "未登录" }, 401)

  const url = new URL(req.url)
  const status = url.searchParams.get("status") ?? undefined
  const repo = url.searchParams.get("repo") ?? undefined

  const tasks = await listTasks(auth.supabase, auth.userId, { status, repo })
  return json(tasks)
}
