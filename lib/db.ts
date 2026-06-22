// Supabase 数据访问层：记忆、对话、消息的云端读写
// 所有数据都带 user_id，靠数据库 RLS 保证账号隔离（用户只能读写自己的）
import { createClient } from "@/lib/supabase/client"
import type { Memory } from "@/lib/memory-data"
import type { Conversation, Message } from "@/lib/chat-data"
import type { Project, ProjectFile, ProjectContext } from "@/lib/project-data"

function fmtDate(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return "今日"
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

// 取最后一条有内容的消息做列表预览
export function lastExcerpt(msgs: Message[]): string {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const t = msgs[i].content?.trim()
    if (t) return t.slice(0, 60)
  }
  return ""
}

// ───────────── 用户档案（记忆开关 / 额度） ─────────────

export type Profile = { memoryEnabled: boolean }

// 读取当前登录用户的档案；没有行就返回默认值（记忆默认开启）
export async function fetchProfile(): Promise<Profile> {
  const supabase = createClient()
  const { data } = await supabase.from("profiles").select("memory_enabled").maybeSingle()
  return { memoryEnabled: data?.memory_enabled ?? true }
}

// 确保档案行存在（登录后调用一次）；已存在则不动
export async function ensureProfile(userId: string): Promise<void> {
  const supabase = createClient()
  const { error } = await supabase
    .from("profiles")
    .upsert({ user_id: userId }, { onConflict: "user_id", ignoreDuplicates: true })
  if (error) console.error("ensureProfile", error)
}

// 切换记忆总开关
export async function setMemoryEnabled(userId: string, enabled: boolean): Promise<void> {
  const supabase = createClient()
  const { error } = await supabase
    .from("profiles")
    .upsert({ user_id: userId, memory_enabled: enabled }, { onConflict: "user_id" })
  if (error) console.error("setMemoryEnabled", error)
}

// ───────────── 记忆 ─────────────

export async function fetchMemories(): Promise<Memory[]> {
  const supabase = createClient()
  const { data, error } = await supabase
    .from("memories")
    .select("id, content")
    .order("created_at", { ascending: true })
  if (error || !data) return []
  return data.map(r => ({ id: r.id as string, content: r.content as string }))
}

export async function insertMemory(userId: string, content: string): Promise<Memory | null> {
  const supabase = createClient()
  const id = crypto.randomUUID()
  const { error } = await supabase.from("memories").insert({ id, user_id: userId, content })
  if (error) { console.error("insertMemory", error); return null }
  return { id, content }
}

export async function updateMemory(id: string, content: string): Promise<void> {
  const supabase = createClient()
  const { error } = await supabase
    .from("memories")
    .update({ content, updated_at: new Date().toISOString() })
    .eq("id", id)
  if (error) console.error("updateMemory", error)
}

export async function deleteMemoryRow(id: string): Promise<void> {
  const supabase = createClient()
  const { error } = await supabase.from("memories").delete().eq("id", id)
  if (error) console.error("deleteMemoryRow", error)
}

// ───────────── 对话 ─────────────

export async function fetchConversations(): Promise<Conversation[]> {
  const supabase = createClient()
  const { data, error } = await supabase
    .from("conversations")
    .select("id, title, updated_at, project_id, starred, pinned, messages(count)")
    .order("pinned", { ascending: false })
    .order("updated_at", { ascending: false })
  if (error || !data) return []
  return data.map(r => {
    // 仅当 count 明确返回为数字时才采用；拿不到就留 undefined（按"非空"对待，绝不误删/误藏）
    const m = (r as any).messages
    const msgCount = Array.isArray(m) && m.length > 0 && typeof m[0]?.count === "number" ? (m[0].count as number) : undefined
    return {
      id: r.id as string,
      title: r.title as string,
      excerpt: "",
      date: fmtDate(r.updated_at as string),
      messages: [],
      projectId: (r.project_id as string) ?? null,
      starred: !!r.starred,
      pinned: !!r.pinned,
      msgCount,
    }
  })
}

export async function insertConversation(userId: string, title: string, projectId?: string | null): Promise<string | null> {
  const supabase = createClient()
  const id = crypto.randomUUID()
  const row: Record<string, unknown> = { id, user_id: userId, title }
  if (projectId) row.project_id = projectId
  const { error } = await supabase.from("conversations").insert(row)
  if (error) { console.error("insertConversation", error); return null }
  return id
}

export async function updateConversationTitle(id: string, title: string): Promise<void> {
  const supabase = createClient()
  const { error } = await supabase
    .from("conversations")
    .update({ title, updated_at: new Date().toISOString() })
    .eq("id", id)
  if (error) console.error("updateConversationTitle", error)
}

export async function setConversationStarred(id: string, starred: boolean): Promise<void> {
  const supabase = createClient()
  const { error } = await supabase.from("conversations").update({ starred }).eq("id", id)
  if (error) console.error("setConversationStarred", error)
}

export async function setConversationPinned(id: string, pinned: boolean): Promise<void> {
  const supabase = createClient()
  const { error } = await supabase.from("conversations").update({ pinned }).eq("id", id)
  if (error) console.error("setConversationPinned", error)
}

export async function setConversationProject(id: string, projectId: string | null): Promise<void> {
  const supabase = createClient()
  const { error } = await supabase.from("conversations").update({ project_id: projectId }).eq("id", id)
  if (error) console.error("setConversationProject", error)
}

export async function touchConversation(id: string): Promise<void> {
  const supabase = createClient()
  await supabase.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", id)
}

export async function deleteConversationRow(id: string): Promise<void> {
  const supabase = createClient()
  const { error } = await supabase.from("conversations").delete().eq("id", id)
  if (error) console.error("deleteConversationRow", error)
}

// ───────────── 消息 ─────────────

export async function fetchMessages(conversationId: string): Promise<Message[]> {
  const supabase = createClient()
  const { data, error } = await supabase
    .from("messages")
    .select("id, role, content, images, thinking, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
  if (error || !data) return []
  return data.map(r => ({
    id: r.id as string,
    role: r.role as "user" | "assistant",
    content: (r.content as string) ?? "",
    thinking: (r.thinking as string) || undefined,
    images: (r.images as string[]) || undefined,
    time: "",
  }))
}

export async function insertMessage(userId: string, conversationId: string, msg: Message): Promise<void> {
  const supabase = createClient()
  const { error } = await supabase.from("messages").insert({
    id: msg.id,
    conversation_id: conversationId,
    user_id: userId,
    role: msg.role,
    content: msg.content,
    images: msg.images ?? null,
    thinking: msg.thinking ?? null,
  })
  if (error) console.error("insertMessage", error)
}

export async function deleteMessageRow(id: string): Promise<void> {
  const supabase = createClient()
  const { error } = await supabase.from("messages").delete().eq("id", id)
  if (error) console.error("deleteMessageRow", error)
}

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

// 聊天时取项目背景：专属指令 + 资料正文（喂给模型当上下文）
export async function fetchProjectContext(projectId: string): Promise<ProjectContext> {
  const supabase = createClient()
  const [{ data: proj }, files] = await Promise.all([
    supabase.from("projects").select("instructions").eq("id", projectId).maybeSingle(),
    fetchProjectFiles(projectId),
  ])
  return {
    instructions: (proj?.instructions as string) ?? "",
    files: files.map(f => ({ name: f.name, content: f.content })),
  }
}
