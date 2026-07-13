import { createClient } from "@/lib/supabase/client"
import type { Conversation, Message } from "@/lib/chat-data"
import { parseArtifact, artifactTitle } from "@/lib/artifact"
import { normalizeGeneratedMediaList } from "@/lib/generated-media"
import {
  generationTerminalWarning,
  normalizeMessageGeneration,
} from "@/lib/generation-message"
import { insertArtifactFromMessage } from "./artifacts"
import { fmtDate } from "./shared"
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

async function saveMessageArtifact(userId: string, conversationId: string, msg: Message) {
  if (msg.role !== "assistant" || !msg.content) return
  const parsed = parseArtifact(msg.content)
  if (!parsed.raw || !parsed.done) return
  await insertArtifactFromMessage({
    userId,
    conversationId,
    messageId: msg.id,
    title: artifactTitle(parsed.raw),
    raw: parsed.raw,
  })
}

function normalizeMessageRow(r: any): Message {
  const stored = r.images as unknown
  const generation = !Array.isArray(stored)
    ? normalizeMessageGeneration((stored as any)?.generation)
    : undefined
  const images = Array.isArray(stored)
    ? stored.filter((value): value is string => typeof value === "string")
    : Array.isArray((stored as any)?.refs)
      ? (stored as any).refs.filter((value: unknown): value is string => typeof value === "string")
      : undefined
  const imageSummary = !Array.isArray(stored) && typeof (stored as any)?.image_summary === "string"
    ? (stored as any).image_summary as string
    : undefined
  const media = !Array.isArray(stored) ? normalizeGeneratedMediaList((stored as any)?.generated_media) : []
  return {
    id: r.id as string,
    role: r.role as "user" | "assistant",
    content: (r.content as string) ?? "",
    thinking: (r.thinking as string) || undefined,
    images: images?.length ? images : undefined,
    imageSummary,
    media: media.length ? media : undefined,
    isError: generation?.status === "failed" ? true : undefined,
    outputWarning: generationTerminalWarning(generation),
    generation,
    time: "",
    ts: (r.created_at as string) || undefined,
  }
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
  const messages = data.map(normalizeMessageRow).reverse()
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
    const list = fallback.map(r => ({
      id: r.id as string,
      title: r.title as string,
      excerpt: "",
      date: fmtDate(r.updated_at as string),
      messages: [],
      projectId: (r.project_id as string) ?? null,
      starred: false,
      pinned: false,
    }))
    warmRecentMessageCaches(list.map(c => c.id))
    return list
  }

  const list = data.map(r => {
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
  warmRecentMessageCaches(list.map(c => c.id))
  return list
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

export async function insertMessage(userId: string, conversationId: string, msg: Message): Promise<void> {
  const generatedMedia = normalizeGeneratedMediaList(msg.media)
  const safeMessage: Message = {
    ...msg,
    media: generatedMedia.length ? generatedMedia : undefined,
  }
  const cached = await readCachedMessages(conversationId)
  const next = [...cached.filter(m => m.id !== msg.id), safeMessage]

  const supabase = createClient()
  const mediaPayload = msg.images?.length || msg.imageSummary || generatedMedia.length
    ? {
      refs: msg.images ?? [],
      image_summary: msg.imageSummary ?? null,
      generated_media: generatedMedia,
    }
    : null
  const { error } = await supabase.from("messages").insert({
    id: msg.id,
    conversation_id: conversationId,
    user_id: userId,
    role: msg.role,
    content: msg.content,
    images: mediaPayload,
    thinking: msg.thinking ?? null,
  })
  if (error) {
    console.error("insertMessage", error)
    throw new Error("消息保存失败，请检查网络后重试。")
  }
  writeCachedMessages(conversationId, next)
  saveMessageArtifact(userId, conversationId, safeMessage).catch(e => console.error("saveMessageArtifact", e))
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
  const patch: Record<string, unknown> = {}
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
      ? {
        ...prev,
        refs: nextRefs,
        image_summary: nextSummary,
        generated_media: nextMedia,
      }
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
