import { createClient } from "@/lib/supabase/client"
import type { Memory } from "@/lib/memory-data"
import type { Project, ProjectFile, ProjectContext } from "@/lib/project-data"
import { fmtDate } from "./shared"

// ───────────── 项目 ─────────────

export async function fetchProjects(): Promise<Project[]> {
  const supabase = createClient()
  const { data, error } = await supabase
    .from("projects")
    .select("id, name, instructions, updated_at")
    .order("updated_at", { ascending: false })
  if (error || !data) return []
  return data.map(r => ({
    id: r.id as string,
    name: r.name as string,
    instructions: (r.instructions as string) ?? "",
    date: fmtDate(r.updated_at as string),
  }))
}

export async function insertProject(userId: string, name: string): Promise<Project | null> {
  const supabase = createClient()
  const id = crypto.randomUUID()
  const { error } = await supabase.from("projects").insert({ id, user_id: userId, name })
  if (error) { console.error("insertProject", error); return null }
  return { id, name, instructions: "", date: "今日" }
}

export async function updateProject(id: string, patch: { name?: string; instructions?: string }): Promise<void> {
  const supabase = createClient()
  const { error } = await supabase
    .from("projects")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
  if (error) console.error("updateProject", error)
}

export async function deleteProjectRow(id: string): Promise<void> {
  const supabase = createClient()
  const { error } = await supabase.from("projects").delete().eq("id", id)
  if (error) console.error("deleteProjectRow", error)
}

// ───────────── 项目资料 ─────────────

export async function fetchProjectFiles(projectId: string): Promise<ProjectFile[]> {
  const supabase = createClient()
  const { data, error } = await supabase
    .from("project_files")
    .select("id, name, content")
    .eq("project_id", projectId)
    .order("created_at", { ascending: true })
  if (error || !data) return []
  return data.map(r => ({ id: r.id as string, name: r.name as string, content: (r.content as string) ?? "" }))
}

export async function insertProjectFile(userId: string, projectId: string, name: string, content: string): Promise<ProjectFile | null> {
  const supabase = createClient()
  const id = crypto.randomUUID()
  const { error } = await supabase.from("project_files").insert({ id, project_id: projectId, user_id: userId, name, content })
  if (error) { console.error("insertProjectFile", error); return null }
  return { id, name, content }
}

export async function deleteProjectFileRow(id: string): Promise<void> {
  const supabase = createClient()
  const { error } = await supabase.from("project_files").delete().eq("id", id)
  if (error) console.error("deleteProjectFileRow", error)
}

// ───────────── 项目记忆（与全局 memories 完全分隔，按 project_id 隔离） ─────────────

export async function fetchProjectMemories(projectId: string): Promise<Memory[]> {
  const supabase = createClient()
  const { data, error } = await supabase
    .from("project_memories")
    .select("id, content, created_at, updated_at")
    .eq("project_id", projectId)
    .order("created_at", { ascending: true })
  if (error || !data) return []
  return data.map(r => ({
    id: r.id as string,
    content: r.content as string,
    timestamp: (r.updated_at as string) || (r.created_at as string) || undefined,
  }))
}

export async function insertProjectMemory(userId: string, projectId: string, content: string): Promise<Memory | null> {
  const supabase = createClient()
  const id = crypto.randomUUID()
  const ts = new Date().toISOString()
  const { error } = await supabase.from("project_memories").insert({ id, user_id: userId, project_id: projectId, content })
  if (error) { console.error("insertProjectMemory", error); return null }
  return { id, content, timestamp: ts }
}

export async function updateProjectMemory(id: string, content: string): Promise<void> {
  const supabase = createClient()
  const { error } = await supabase
    .from("project_memories")
    .update({ content, updated_at: new Date().toISOString() })
    .eq("id", id)
  if (error) console.error("updateProjectMemory", error)
}

export async function deleteProjectMemoryRow(id: string): Promise<void> {
  const supabase = createClient()
  const { error } = await supabase.from("project_memories").delete().eq("id", id)
  if (error) console.error("deleteProjectMemoryRow", error)
}

// 聊天时取项目背景：专属指令 + 资料正文 + 项目记忆（喂给模型当上下文）
export async function fetchProjectContext(projectId: string): Promise<ProjectContext> {
  const supabase = createClient()
  const [{ data: proj }, files, mems] = await Promise.all([
    supabase.from("projects").select("instructions").eq("id", projectId).maybeSingle(),
    fetchProjectFiles(projectId),
    fetchProjectMemories(projectId),
  ])
  return {
    id: projectId,
    instructions: (proj as { instructions: string } | null)?.instructions ?? "",
    files: files.map(f => ({ name: f.name, content: f.content })),
    projectMemories: mems.map(m => ({ id: m.id, content: m.content })),
  }
}
