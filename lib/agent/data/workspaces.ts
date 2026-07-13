import type { SupabaseClient } from "@supabase/supabase-js"
import type { AgentArtifact, AgentWorkspace, WorkspaceStatus } from "../types"
import { mapArtifact, mapWorkspace } from "../data-mappers"

export async function addWorkspace(
  supabase: SupabaseClient,
  userId: string,
  workspace: {
    taskId: string
    repo: string
    branch?: string
    commitSha?: string
    path?: string
  },
): Promise<AgentWorkspace | { error: string }> {
  const now = new Date().toISOString()
  const { error, data } = await supabase
    .from("agent_workspaces")
    .upsert({
      id: crypto.randomUUID(),
      task_id: workspace.taskId,
      user_id: userId,
      repo: workspace.repo,
      branch: workspace.branch ?? "main",
      commit_sha: workspace.commitSha ?? null,
      path: workspace.path ?? null,
      status: "created",
      created_at: now,
      updated_at: now,
    }, { onConflict: "task_id" })
    .select()
    .single()

  if (error || !data) return { error: error?.message ?? "写入 workspace 失败" }
  return mapWorkspace(data)
}

export async function updateWorkspaceStatus(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
  status: WorkspaceStatus,
  extra?: { path?: string; commitSha?: string },
): Promise<AgentWorkspace | { error: string }> {
  const update: Record<string, unknown> = {
    status,
    updated_at: new Date().toISOString(),
  }
  if (extra?.path) update.path = extra.path
  if (extra?.commitSha) update.commit_sha = extra.commitSha

  const { error, data } = await supabase
    .from("agent_workspaces")
    .update(update)
    .eq("task_id", taskId)
    .eq("user_id", userId)
    .select()
    .single()

  if (error || !data) return { error: error?.message ?? "更新 workspace 失败" }
  return mapWorkspace(data)
}

export async function addArtifact(
  supabase: SupabaseClient,
  userId: string,
  artifact: {
    taskId: string
    kind: AgentArtifact["kind"]
    title?: string
    content?: string
    url?: string
    meta?: Record<string, unknown>
  },
): Promise<AgentArtifact | { error: string }> {
  const { error, data } = await supabase
    .from("agent_artifacts")
    .insert({
      id: crypto.randomUUID(),
      task_id: artifact.taskId,
      user_id: userId,
      kind: artifact.kind,
      title: artifact.title ?? null,
      content: artifact.content ?? null,
      url: artifact.url ?? null,
      meta: artifact.meta ?? null,
    })
    .select()
    .single()

  if (error || !data) return { error: error?.message ?? "写入产物失败" }
  return mapArtifact(data)
}
