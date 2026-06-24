// POST  /api/agent/tasks     — 创建任务
// GET   /api/agent/tasks     — 查询任务列表
import { NextRequest } from "next/server"
import { resolveAuth } from "@/lib/api/guard"
import { createTask, listTasks } from "@/lib/agent/data"
import type { CreateTaskInput } from "@/lib/agent/types"

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } })
}

export async function POST(req: NextRequest) {
  const auth = await resolveAuth()
  if (!auth.supabase || !auth.userId) return json({ error: "未登录" }, 401)

  const body: CreateTaskInput = await req.json().catch(() => null)
  if (!body?.goal) return json({ error: "缺少 goal" }, 400)

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
