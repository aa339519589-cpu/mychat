// POST  /api/agent/tasks     — 创建任务
// GET   /api/agent/tasks     — 查询任务列表
import { NextRequest } from "next/server"
import { resolveAuth } from "@/lib/api/guard"
import { json } from "@/lib/api/response"
import { listTasks } from "@/lib/agent/data"

export async function POST() {
  return json({ error: "独立 Task 创建已停用；Task 与首个 Agent Job 必须通过 /api/code/chat 原子创建。" }, 410)
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
