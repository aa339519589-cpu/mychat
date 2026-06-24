import { createClient } from "@/lib/supabase/client"
import type { Conversation, Message } from "@/lib/chat-data"
import { fmtDate } from "./shared"

// ───────────── 对话 ─────────────

export async function fetchConversations(): Promise<Conversation[]> {
  const supabase = createClient()
  const { data, error } = await supabase
    .from("conversations")
    .select("id, title, updated_at, project_id, starred, pinned, messages(count)")
    .order("pinned", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(100)

  if (error || !data) {
    const { data: fallback } = await supabase
      .from("conversations")
      .select("id, title, updated_at, project_id")
      .order("updated_at", { ascending: false })
    if (!fallback) return []
    return fallback.map(r => ({
      id: r.id as string,
      title: r.title as string,
      excerpt: "",
      date: fmtDate(r.updated_at as string),
      messages: [],
      projectId: (r.project_id as string) ?? null,
      starred: false,
      pinned: false,
    }))
  }

  return data.map(r => {
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
  return data.map(r => {
    const stored = r.images as unknown
    const images = Array.isArray(stored)
      ? stored.filter((value): value is string => typeof value === "string")
      : Array.isArray((stored as any)?.refs)
        ? (stored as any).refs.filter((value: unknown): value is string => typeof value === "string")
        : undefined
    const imageSummary = !Array.isArray(stored) && typeof (stored as any)?.image_summary === "string"
      ? (stored as any).image_summary as string
      : undefined
    return {
      id: r.id as string,
      role: r.role as "user" | "assistant",
      content: (r.content as string) ?? "",
      thinking: (r.thinking as string) || undefined,
      images: images?.length ? images : undefined,
      imageSummary,
      time: "",
      ts: (r.created_at as string) || undefined,
    }
  })
}

export async function insertMessage(userId: string, conversationId: string, msg: Message): Promise<void> {
  const supabase = createClient()
  const { error } = await supabase.from("messages").insert({
    id: msg.id,
    conversation_id: conversationId,
    user_id: userId,
    role: msg.role,
    content: msg.content,
    images: msg.images?.length ? { refs: msg.images, image_summary: msg.imageSummary ?? null } : null,
    thinking: msg.thinking ?? null,
  })
  if (error) console.error("insertMessage", error)
}

export async function deleteMessageRow(id: string): Promise<void> {
  const supabase = createClient()
  const { error } = await supabase.from("messages").delete().eq("id", id)
  if (error) console.error("deleteMessageRow", error)
}
