// Supabase 数据访问层：记忆、对话、消息的云端读写
// 所有数据都带 user_id，靠数据库 RLS 保证账号隔离（用户只能读写自己的）
import { createClient } from "@/lib/supabase/client"
import type { Memory } from "@/lib/memory-data"
import type { Conversation, Message, Endpoint } from "@/lib/chat-data"

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
    .select("id, title, updated_at")
    .order("updated_at", { ascending: false })
  if (error || !data) return []
  return data.map(r => ({
    id: r.id as string,
    title: r.title as string,
    excerpt: "",
    date: fmtDate(r.updated_at as string),
    messages: [],
  }))
}

export async function insertConversation(userId: string, title: string): Promise<string | null> {
  const supabase = createClient()
  const id = crypto.randomUUID()
  const { error } = await supabase.from("conversations").insert({ id, user_id: userId, title })
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

// ───────────── 模型端点（含 API Key，靠 RLS 隔离，只有本人能读） ─────────────

export async function fetchEndpoints(): Promise<Endpoint[]> {
  const supabase = createClient()
  const { data, error } = await supabase
    .from("endpoints")
    .select("id, name, protocol, base_url, api_key, model")
    .order("created_at", { ascending: true })
  if (error || !data) return []
  return data.map(r => ({
    id: r.id as string,
    name: r.name as string,
    protocol: r.protocol as Endpoint["protocol"],
    baseUrl: r.base_url as string,
    apiKey: r.api_key as string,
    model: r.model as string,
  }))
}

export async function insertEndpoint(userId: string, ep: Endpoint): Promise<{ ok: boolean; error?: string }> {
  const supabase = createClient()
  const { error } = await supabase.from("endpoints").insert({
    id: ep.id,
    user_id: userId,
    name: ep.name,
    protocol: ep.protocol,
    base_url: ep.baseUrl,
    api_key: ep.apiKey,
    model: ep.model,
  })
  if (error) {
    console.error("insertEndpoint", error)
    return { ok: false, error: error.message }
  }
  return { ok: true }
}

export async function deleteEndpointRow(id: string): Promise<void> {
  const supabase = createClient()
  const { error } = await supabase.from("endpoints").delete().eq("id", id)
  if (error) console.error("deleteEndpointRow", error)
}

export async function deleteMessageRow(id: string): Promise<void> {
  const supabase = createClient()
  const { error } = await supabase.from("messages").delete().eq("id", id)
  if (error) console.error("deleteMessageRow", error)
}
