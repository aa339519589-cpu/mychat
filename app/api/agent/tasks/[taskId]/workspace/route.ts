// POST /api/agent/tasks/[taskId]/workspace  — 创建或获取 workspace
// GET  /api/agent/tasks/[taskId]/workspace  — 获取 workspace 信息
import { NextRequest } from "next/server"
import { cookies } from "next/headers"
import { resolveAuth } from "@/lib/api/guard"
import { createWorkspaceForTask, workspacePath } from "@/lib/agent/workspace"
import { getGitInfo } from "@/lib/agent/git-workspace"
import { repoMeta } from "@/lib/github"
import { existsSync } from "fs"
import { createRecorder } from "@/lib/agent/recorder"

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const auth = await resolveAuth()
  if (!auth.supabase || !auth.userId) return json({ error: "未登录" }, 401)

  const { taskId } = await params
  const store = await cookies()
  const token = store.get("gh_access_token")?.value
  if (!token) return json({ error: "未连接 GitHub" }, 401)

  // 校验 task 归属
  const { data: task } = await auth.supabase.from("agent_tasks")
    .select("id, goal, repo, status").eq("id", taskId).eq("user_id", auth.userId).single()
  if (!task) return json({ error: "任务不存在" }, 404)
  if (!task.repo) return json({ error: "任务未关联仓库" }, 400)

  const recorder = createRecorder({ supabase: auth.supabase, userId: auth.userId, taskId })

  // 检查 workspace 是否已存在
  const base = workspacePath(auth.userId, taskId)
  if (existsSync(base)) {
    const info = await getGitInfo(base)
    await recorder.step("info", "Workspace 已存在")
    if ("error" in info) return json({ path: base, status: "ready" })
    return json({ path: base, status: "ready", branch: info.branch, commit: info.commit })
  }

  await recorder.step("planning", "开始创建 workspace")
  await recorder.step("tool_call", "正在 clone 仓库")

  // 获取仓库默认分支（避免 clone 非 main 分支仓库失败）
  let defaultBranch = "main"
  try {
    const meta = await repoMeta(token, task.repo)
    if (meta?.defaultBranch) defaultBranch = meta.defaultBranch
  } catch { /* fallback to "main" */ }

  const result = await createWorkspaceForTask(
    auth.supabase, auth.userId, taskId,
    token, task.repo, task.goal ?? "task", defaultBranch,
  )

  if ("error" in result) {
    await recorder.step("failed", "Workspace 创建失败", result.error)
    await recorder.setTaskStatus("failed", result.error)
    return json({ error: result.error }, 500)
  }

  await recorder.step("done", `Workspace ready · ${result.agentBranch}`)
  await recorder.artifact("summary", {
    title: "Workspace",
    content: `repo: ${result.repo}\nbase: ${result.baseBranch}\nagent: ${result.agentBranch}\ncommit: ${result.commit ?? "unknown"}`,
  })
  return json(result)
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const auth = await resolveAuth()
  if (!auth.supabase || !auth.userId) return json({ error: "未登录" }, 401)

  const { taskId } = await params

  // 校验 task 归属
  const { data: task } = await auth.supabase
    .from("agent_tasks").select("id").eq("id", taskId).eq("user_id", auth.userId).single()
  if (!task) return json({ error: "任务不存在" }, 404)

  const base = workspacePath(auth.userId, taskId)
  if (!existsSync(base)) return json({ status: "not_created" })

  const info = await getGitInfo(base)
  if ("error" in info) return json({ path: base, status: "ready" })

  return json({ path: base, status: "ready", branch: info.branch, commit: info.commit })
}
