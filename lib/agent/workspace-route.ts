import { resolveAuth, type SupabaseServer } from "@/lib/api/guard"
import { json } from "@/lib/api/response"

type WorkspaceRouteContext = {
  supabase: SupabaseServer
  userId: string
}

type WorkspaceRouteResult =
  | WorkspaceRouteContext
  | { error: Response }

export async function requireWorkspace(
  taskId: string,
  options: { ready?: boolean; path?: boolean } = {},
): Promise<WorkspaceRouteResult> {
  const { supabase, userId } = await resolveAuth()
  if (!supabase || !userId) return { error: json({ error: "未登录" }, 401) }

  const { data: task } = await supabase
    .from("agent_tasks")
    .select("id")
    .eq("id", taskId)
    .eq("user_id", userId)
    .maybeSingle()
  if (!task) return { error: json({ error: "任务不存在" }, 404) }

  const { data: workspace } = await supabase
    .from("agent_workspaces")
    .select("status,path")
    .eq("task_id", taskId)
    .eq("user_id", userId)
    .maybeSingle()

  if (!workspace) {
    const status = options.ready === false ? 404 : 400
    return { error: json({ error: options.ready === false ? "Workspace 不存在" : "Workspace 未就绪" }, status) }
  }
  if (options.ready !== false && workspace.status !== "ready" && workspace.status !== "dirty") {
    return { error: json({ error: "Workspace 未就绪" }, 400) }
  }
  if (options.path && !workspace.path) return { error: json({ error: "Workspace 路径为空" }, 500) }

  return { supabase, userId }
}
