import { createClient } from "@/lib/supabase/client"
import type { Conversation, Message } from "@/lib/chat-data"
import { normalizeGeneratedMediaList } from "@/lib/generated-media"
import { normalizeMessageGeneration } from "@/lib/generation-message"
import { fmtDate } from "./shared"
import { normalizeMessageRow, type ConversationRow, type MessageRow } from "./conversation-rows"
import type { TablesInsert, TablesUpdate } from '@/lib/supabase/types'
import { toJson } from '@/lib/supabase/json'
import {
  MESSAGE_CACHE_WARM_LIMIT,
  REMOTE_MESSAGE_LIMIT,
  mergeCachedMessages,
  readCachedMessages,
  removeCachedMessages,
  updateCachedMessageContent,
  writeCachedMessages,
} from "./message-cache"

export { cacheConversationMessages, mergeCachedMessages } from "./message-cache"
export { removeCachedMessages } from "./message-cache"

const warming = new Set<string>()

function delay(ms: number) {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}

function warmRecentMessageCaches(ids: string[]) {
  if (typeof window === "undefined") return
  window.setTimeout(async () => {
    for (const id of ids.slice(0, MESSAGE_CACHE_WARM_LIMIT)) {
      if (warming.has(id)) continue
      const cached = await readCachedMessages(id)
      if (cached.length) continue
      warming.add(id)
      try {
        const messages = await fetchRemoteMessages(id, REMOTE_MESSAGE_LIMIT)
        if (messages.length) writeCachedMessages(id, messages)
      } catch {
      } finally {
        warming.delete(id)
      }
      await delay(220)
    }
  }, 700)
}

async function fetchRemoteMessages(conversationId: string, limit = REMOTE_MESSAGE_LIMIT): Promise<Message[]> {
  const supabase = createClient()
  const { data, error } = await supabase
    .from("messages")
    .select("id, role, content, images, thinking, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(limit)
  if (error) throw new Error("消息同步暂时不可用", { cause: error })
  if (!data) throw new Error("消息同步响应无效")
  const messages = (data as MessageRow[]).map(normalizeMessageRow).reverse()
  if (typeof window !== "undefined") {
    for (const message of messages) {
      if (message.media?.length) {
        console.info("[chat-history] hydrated message", {
          messageId: message.id,
          conversationId,
          mediaCount: message.media.length,
          media: message.media.map(item => ({
            type: item.type,
            urlKind: item.url.startsWith("data:") ? "data" : item.url.startsWith("http") ? "http" : "other",
            urlLen: item.url.length,
          })),
        })
      }
    }
  }
  return messages
}

// ───────────── 对话 ─────────────

export async function fetchConversations(): Promise<Conversation[]> {
  const supabase = createClient()
  const { data, error } = await supabase
    .from("conversations")
    .select("id, title, updated_at, project_id, starred, pinned, messages!messages_conversation_id_fkey(count)")
    .order("pinned", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(100)

  if (error || !data) {
    const { data: fallback } = await supabase
      .from("conversations")
      .select("id, title, updated_at, project_id")
      .order("updated_at", { ascending: false })
    if (!fallback) return []
    const list = (fallback as ConversationRow[]).map(row => ({
      id: row.id,
      title: row.title,
      excerpt: "",
      date: fmtDate(row.updated_at),
      messages: [],
      projectId: row.project_id,
      starred: false,
      pinned: false,
    }))
    warmRecentMessageCaches(list.map(c => c.id))
    return list
  }

  const list = (data as ConversationRow[]).map(row => {
    const messageCounts = row.messages
    const msgCount = Array.isArray(messageCounts) && typeof messageCounts[0]?.count === "number"
      ? messageCounts[0].count
      : undefined
    return {
      id: row.id,
      title: row.title,
      excerpt: "",
      date: fmtDate(row.updated_at),
      messages: [],
      projectId: row.project_id,
      starred: Boolean(row.starred),
      pinned: Boolean(row.pinned),
      msgCount,
    }
  })
  warmRecentMessageCaches(list.map(c => c.id))
  return list
}

export async function insertConversation(userId: string, title: string, projectId?: string | null): Promise<string | null> {
  const supabase = createClient()
  const id = crypto.randomUUID()
  const row: TablesInsert<'conversations'> = { id, user_id: userId, title }
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
  const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" })
  if (!response.ok) {
    console.error("deleteConversationRow", response.status)
    throw new Error("会话删除失败，请稍后重试。")
  }
  removeCachedMessages(id)
}

// ───────────── 消息 ─────────────

export async function fetchMessages(
  conversationId: string,
  options: { fresh?: boolean } = {},
): Promise<Message[]> {
  const cached = await readCachedMessages(conversationId)

  if (options.fresh) {
    const messages = await fetchRemoteMessages(conversationId, REMOTE_MESSAGE_LIMIT)
    if (messages.length > 0) {
      const latestCached = await readCachedMessages(conversationId)
      const reconciled = mergeCachedMessages(latestCached, messages)
      await writeCachedMessages(conversationId, reconciled)
      return reconciled
    }
    await writeCachedMessages(conversationId, [])
    return []
  }

  if (cached.length > 0) return cached

  // 首次打开也只取最近一屏需要的消息，不再把几百上千条旧消息一次性拉进 DOM。
  const messages = await fetchRemoteMessages(conversationId, REMOTE_MESSAGE_LIMIT)
  if (messages.length > 0) await writeCachedMessages(conversationId, messages)
  return messages
}

export async function updateMessageContent(conversationId: string, messageId: string, content: string): Promise<void> {
  const supabase = createClient()
  const { error } = await supabase.from("messages").update({ content }).eq("id", messageId)
  if (error) {
    console.error("updateMessageContent", error)
    throw new Error("消息修改失败，请检查网络后重试。")
  }
  await updateCachedMessageContent(conversationId, messageId, content)
}

export async function updateMessageFields(
  conversationId: string,
  messageId: string,
  fields: {
    content?: string
    thinking?: string | null
    media?: import("@/lib/generated-media").GeneratedMedia[]
    images?: string[]
    imageSummary?: string | null
  },
): Promise<void> {
  const supabase = createClient()
  const generatedMedia = fields.media !== undefined
    ? normalizeGeneratedMediaList(fields.media)
    : undefined
  const patch: TablesUpdate<'messages'> = {}
  if (fields.content !== undefined) patch.content = fields.content
  if (fields.thinking !== undefined) patch.thinking = fields.thinking
  if (fields.media !== undefined || fields.images !== undefined || fields.imageSummary !== undefined) {
    // Merge with existing row so we never wipe refs accidentally when only media is set.
    const { data: existing } = await supabase
      .from("messages")
      .select("images")
      .eq("id", messageId)
      .maybeSingle()
    const prev = (existing?.images && typeof existing.images === "object" && !Array.isArray(existing.images))
      ? existing.images as Record<string, unknown>
      : {}
    const prevMedia = normalizeGeneratedMediaList(prev.generated_media)
    const nextMedia = generatedMedia !== undefined ? generatedMedia : prevMedia
    const nextRefs = fields.images !== undefined
      ? fields.images
      : Array.isArray(prev.refs) ? prev.refs as string[] : []
    const nextSummary = fields.imageSummary !== undefined
      ? fields.imageSummary
      : (typeof prev.image_summary === "string" ? prev.image_summary : null)
    const generation = normalizeMessageGeneration(prev.generation)
    patch.images = (nextMedia.length || nextRefs.length || nextSummary || generation)
      ? toJson({
        ...prev,
        refs: nextRefs,
        image_summary: nextSummary,
        generated_media: nextMedia,
      })
      : null
  }
  const { error } = await supabase.from("messages").update(patch).eq("id", messageId)
  if (error) {
    console.error("updateMessageFields", error)
    throw new Error("消息更新失败，请检查网络后重试。")
  }
  // Refresh local/idb cache for this message
  try {
    const cached = await readCachedMessages(conversationId)
    if (cached.length) {
      const next = cached.map(m => {
        if (m.id !== messageId) return m
        return {
          ...m,
          ...(fields.content !== undefined ? { content: fields.content } : {}),
          ...(fields.thinking !== undefined ? { thinking: fields.thinking || undefined } : {}),
          ...(generatedMedia !== undefined ? { media: generatedMedia.length ? generatedMedia : undefined } : {}),
          ...(fields.images !== undefined ? { images: fields.images } : {}),
          ...(fields.imageSummary !== undefined ? { imageSummary: fields.imageSummary || undefined } : {}),
        }
      })
      writeCachedMessages(conversationId, next)
    }
  } catch (e) {
    console.warn("updateMessageFields cache", e)
  }
}

export async function deleteMessageRow(id: string): Promise<void> {
  await deleteMessageRows([id])
}

export async function deleteMessageRows(ids: string[]): Promise<void> {
  const uniqueIds = [...new Set(ids.filter(Boolean))]
  if (uniqueIds.length === 0) return
  const response = await fetch("/api/messages/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: uniqueIds }),
  })
  if (!response.ok) {
    console.error("deleteMessageRows", response.status)
    throw new Error("旧回复删除失败，未开始重新生成。")
  }
}
