import { createClient } from "@/lib/supabase/client"
import type { Conversation, Message } from "@/lib/chat-data"
import { fmtDate } from "./shared"

// ───────────── 本地消息缓存 ─────────────
// 目的：切换会话时有缓存就立刻返回，后台再刷新；不要在会话列表阶段批量解析缓存，避免打开页面更慢。
const MESSAGE_CACHE_PREFIX = "mychat_messages_"
const MESSAGE_CACHE_LIMIT = 120

function cacheKey(conversationId: string) {
  return `${MESSAGE_CACHE_PREFIX}${conversationId}`
}

function readCachedMessages(conversationId: string): Message[] {
  if (typeof window === "undefined") return []
  try {
    const raw = window.localStorage.getItem(cacheKey(conversationId))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((m): m is Message =>
      m &&
      typeof m.id === "string" &&
      (m.role === "user" || m.role === "assistant") &&
      typeof m.content === "string"
    )
  } catch {
    return []
  }
}

function writeCachedMessages(conversationId: string, messages: Message[]) {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(
      cacheKey(conversationId),
      JSON.stringify(messages.slice(-MESSAGE_CACHE_LIMIT)),
    )
  } catch {
    // localStorage 可能满了，缓存失败不影响云端数据。
  }
}

function removeCachedMessages(conversationId: string) {
  if (typeof window === "undefined") return
  try { window.localStorage.removeItem(cacheKey(conversationId)) } catch {}
}

function normalizeMessageRow(r: any): Message {
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
}

async function fetchRemoteMessages(conversationId: string): Promise<Message[]> {
  const supabase = createClient()
  const { data, error } = await supabase
    .from("messages")
    .select("id, role, content, images, thinking, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
  if (error || !data) return []
  return data.map(normalizeMessageRow)
}

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
  removeCachedMessages(id)
  const supabase = createClient()
  const { error } = await supabase.from("conversations").delete().eq("id", id)
  if (error) console.error("deleteConversationRow", error)
}

// ───────────── 消息 ─────────────

export async function fetchMessages(conversationId: string): Promise<Message[]> {
  const cached = readCachedMessages(conversationId)

  if (cached.length > 0) {
    // 有缓存时立刻返回，后台刷新本地缓存；不要让 UI 等 Supabase。
    fetchRemoteMessages(conversationId)
      .then(messages => { if (messages.length > 0) writeCachedMessages(conversationId, messages) })
      .catch(() => {})
    return cached
  }

  const messages = await fetchRemoteMessages(conversationId)
  if (messages.length > 0) writeCachedMessages(conversationId, messages)
  return messages
}

export async function insertMessage(userId: string, conversationId: string, msg: Message): Promise<void> {
  const cached = readCachedMessages(conversationId)
  const next = [...cached.filter(m => m.id !== msg.id), msg]
  writeCachedMessages(conversationId, next)

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
