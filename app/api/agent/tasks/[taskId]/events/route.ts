// GET /api/agent/tasks/[taskId]/events — 任务事件/状态（前端轮询用）
// 返回任务状态 + 最新 steps + 最新 tool_calls，前端可据此更新 UI
import { NextRequest } from "next/server"
import { resolveAuth } from "@/lib/api/guard"

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } })
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const auth = await resolveAuth()
  if (!auth.supabase || !auth.userId) return json({ error: "未登录" }, 401)

  const { taskId } = await params
  const url = new URL(req.url)
  const since = url.searchParams.get("since") // ISO timestamp，只查此时间之后的

  // ① 任务状态
  const { data: task } = await auth.supabase
    .from("agent_tasks")
    .select("id, status, error, updated_at")
    .eq("id", taskId)
    .eq("user_id", auth.userId)
    .single()

  if (!task) return json({ error: "任务不存在" }, 404)

  // ② 步骤
  let stepsQ = auth.supabase
    .from("agent_task_steps")
    .select("id, kind, label, seq, created_at")
    .eq("task_id", taskId)
    .order("seq", { ascending: false })
    .limit(20)

  if (since) stepsQ = stepsQ.gt("created_at", since)

  const { data: steps } = await stepsQ

  // ③ 工具调用
  let tcsQ = auth.supabase
    .from("agent_tool_calls")
    .select("id, tool_name, status, error, started_at, finished_at, duration_ms, seq")
    .eq("task_id", taskId)
    .order("seq", { ascending: false })
    .limit(10)

  if (since) tcsQ = tcsQ.gt("created_at", since)

  const { data: toolCalls } = await tcsQ

  return json({
    taskId: task.id,
    status: task.status,
    error: task.error,
    updatedAt: task.updated_at,
    recentSteps: (steps ?? []).reverse(),
    recentToolCalls: (toolCalls ?? []).reverse(),
  })
}
