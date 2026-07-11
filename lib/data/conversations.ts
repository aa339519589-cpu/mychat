import { createClient } from "@/lib/supabase/client"
import type { Conversation, Message } from "@/lib/chat-data"
import { parseArtifact, artifactTitle } from "@/lib/artifact"
import { hasInlineGeneratedMedia, normalizeGeneratedMediaList } from "@/lib/generated-media"
import { insertArtifactFromMessage } from "./artifacts"
import { fmtDate } from "./shared"

// ───────────── 本地消息缓存 ─────────────
// 目的：切换会话时有缓存就立刻返回，后台再刷新；不能让 UI 等 Supabase 慢查询。
// localStorage 太小，稍微带图/Artifact 就会爆，所以 IndexedDB 做主缓存，localStorage 只做兜底。
const MESSAGE_CACHE_PREFIX = "mychat_messages_"
const MESSAGE_CACHE_DB = "mychat-message-cache"
const MESSAGE_CACHE_STORE = "messages"
const MESSAGE_CACHE_VERSION = 1
const MESSAGE_CACHE_LIMIT = 120
const REMOTE_MESSAGE_LIMIT = 140
const MESSAGE_CACHE_WARM_LIMIT = 8
const LOCAL_CACHE_LIMIT = 50
const LOCAL_CONTENT_LIMIT = 80_000

let dbPromise: Promise<IDBDatabase | null> | null = null
const warming = new Set<string>()

function cacheKey(conversationId: string) {
  return `${MESSAGE_CACHE_PREFIX}${conversationId}`
}

function normalizeCachedMessage(value: any): Message | null {
  if (!value || typeof value.id !== "string") return null
  if (value.role !== "user" && value.role !== "assistant") return null
  if (typeof value.content !== "string") return null
  const media = normalizeGeneratedMediaList(value.media)
  return {
    id: value.id,
    role: value.role,
    content: value.content,
    time: typeof value.time === "string" ? value.time : "",
    ts: typeof value.ts === "string" ? value.ts : undefined,
    isError: value.isError === true ? true : undefined,
    thinking: typeof value.thinking === "string" && value.thinking ? value.thinking : undefined,
    images: Array.isArray(value.images) ? value.images.filter((x: unknown): x is string => typeof x === "string") : undefined,
    imageSummary: typeof value.imageSummary === "string" ? value.imageSummary : undefined,
    media: media.length ? media : undefined,
    memoryNotes: Array.isArray(value.memoryNotes) ? value.memoryNotes.filter((x: unknown): x is string => typeof x === "string") : undefined,
    files: Array.isArray(value.files) ? value.files.filter((x: unknown): x is string => typeof x === "string") : undefined,
    searchNotes: Array.isArray(value.searchNotes) ? value.searchNotes : undefined,
  }
}

function normalizeCachedMessages(value: unknown): Message[] {
  if (!Array.isArray(value)) return []
  return value.map(normalizeCachedMessage).filter((m): m is Message => !!m)
}

function slimForLocalStorage(m: Message): Message {
  return {
    ...m,
    // 图片通常是大 base64，最容易把 localStorage 打爆；缓存文字优先。
    images: m.images?.filter(img => img.length < 120_000).slice(0, 4),
    content: m.content.length > LOCAL_CONTENT_LIMIT
      ? `${m.content.slice(0, LOCAL_CONTENT_LIMIT)}\n\n（此消息过大，已缓存前半部分；完整内容会从云端刷新。）`
      : m.content,
  }
}

function readLocalCachedMessages(conversationId: string): Message[] {
  if (typeof window === "undefined") return []
  try {
    const raw = window.localStorage.getItem(cacheKey(conversationId))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    const messages = normalizeCachedMessages(Array.isArray(parsed) ? parsed : parsed?.messages)
    if (messages.some(message => hasInlineGeneratedMedia(message.media))) {
      window.localStorage.removeItem(cacheKey(conversationId))
      return []
    }
    return messages
  } catch {
    return []
  }
}

function writeLocalCachedMessages(conversationId: string, messages: Message[]) {
  if (typeof window === "undefined") return
  if (messages.some(message => hasInlineGeneratedMedia(message.media))) {
    try { window.localStorage.removeItem(cacheKey(conversationId)) } catch {}
    return
  }
  const write = (count: number, limit: number) => {
    const payload = {
      version: 2,
      ts: Date.now(),
      messages: messages.slice(-count).map(m => ({
        ...slimForLocalStorage(m),
        content: m.content.length > limit ? `${m.content.slice(0, limit)}\n\n（此消息过大，已缓存前半部分；完整内容会从云端刷新。）` : m.content,
      })),
    }
    window.localStorage.setItem(cacheKey(conversationId), JSON.stringify(payload))
  }
  try {
    write(LOCAL_CACHE_LIMIT, LOCAL_CONTENT_LIMIT)
  } catch {
    try { write(18, 24_000) } catch {}
  }
}

function openCacheDb(): Promise<IDBDatabase | null> {
  if (typeof window === "undefined" || !window.indexedDB) return Promise.resolve(null)
  if (dbPromise) return dbPromise
  dbPromise = new Promise(resolve => {
    const req = window.indexedDB.open(MESSAGE_CACHE_DB, MESSAGE_CACHE_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(MESSAGE_CACHE_STORE)) {
        db.createObjectStore(MESSAGE_CACHE_STORE, { keyPath: "conversationId" })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
    req.onblocked = () => resolve(null)
  })
  return dbPromise
}

async function readIndexedCachedMessages(conversationId: string): Promise<Message[]> {
  const db = await openCacheDb()
  if (!db) return []
  return new Promise(resolve => {
    try {
      const tx = db.transaction(MESSAGE_CACHE_STORE, "readonly")
      const req = tx.objectStore(MESSAGE_CACHE_STORE).get(conversationId)
      req.onsuccess = () => resolve(normalizeCachedMessages(req.result?.messages))
      req.onerror = () => resolve([])
    } catch {
      resolve([])
    }
  })
}

async function writeIndexedCachedMessages(conversationId: string, messages: Message[]): Promise<void> {
  const db = await openCacheDb()
  if (!db) return
  return new Promise(resolve => {
    try {
      const tx = db.transaction(MESSAGE_CACHE_STORE, "readwrite")
      tx.objectStore(MESSAGE_CACHE_STORE).put({
        conversationId,
        ts: Date.now(),
        messages: normalizeCachedMessages(messages).slice(-MESSAGE_CACHE_LIMIT),
      })
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
      tx.onabort = () => resolve()
    } catch {
      resolve()
    }
  })
}

async function removeIndexedCachedMessages(conversationId: string): Promise<void> {
  const db = await openCacheDb()
  if (!db) return
  return new Promise(resolve => {
    try {
      const tx = db.transaction(MESSAGE_CACHE_STORE, "readwrite")
      tx.objectStore(MESSAGE_CACHE_STORE).delete(conversationId)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
      tx.onabort = () => resolve()
    } catch {
      resolve()
    }
  })
}

async function readCachedMessages(conversationId: string): Promise<Message[]> {
  const indexed = await readIndexedCachedMessages(conversationId)
  if (indexed.length) return indexed
  return readLocalCachedMessages(conversationId)
}

function writeCachedMessages(conversationId: string, messages: Message[]) {
  const safe = normalizeCachedMessages(messages).slice(-MESSAGE_CACHE_LIMIT)
  if (!safe.length) return
  void writeIndexedCachedMessages(conversationId, safe)
  writeLocalCachedMessages(conversationId, safe)
}

export function cacheConversationMessages(conversationId: string, messages: Message[]) {
  writeCachedMessages(conversationId, messages)
}

async function updateCachedMessageContent(conversationId: string, messageId: string, content: string) {
  const cached = await readCachedMessages(conversationId)
  if (!cached.length) return
  writeCachedMessages(conversationId, cached.map(m => m.id === messageId ? { ...m, content } : m))
}

function removeCachedMessages(conversationId: string) {
  if (typeof window !== "undefined") {
    try { window.localStorage.removeItem(cacheKey(conversationId)) } catch {}
  }
  void removeIndexedCachedMessages(conversationId)
}

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
  if (error || !data) return []
  return data.map(normalizeMessageRow).reverse()
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
  removeCachedMessages(id)
  const supabase = createClient()
  const { error } = await supabase.from("conversations").delete().eq("id", id)
  if (error) console.error("deleteConversationRow", error)
}

// ───────────── 消息 ─────────────

export async function fetchMessages(conversationId: string): Promise<Message[]> {
  const cached = await readCachedMessages(conversationId)

  if (cached.length > 0) {
    // 有缓存时立刻返回，后台刷新本地缓存；不要让 UI 等 Supabase。
    fetchRemoteMessages(conversationId, MESSAGE_CACHE_LIMIT)
      .then(messages => { if (messages.length > 0) writeCachedMessages(conversationId, messages) })
      .catch(() => {})
    return cached
  }

  // 首次打开也只取最近一屏需要的消息，不再把几百上千条旧消息一次性拉进 DOM。
  const messages = await fetchRemoteMessages(conversationId, REMOTE_MESSAGE_LIMIT)
  if (messages.length > 0) writeCachedMessages(conversationId, messages)
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

export async function deleteMessageRow(id: string): Promise<void> {
  await deleteMessageRows([id])
}

export async function deleteMessageRows(ids: string[]): Promise<void> {
  const uniqueIds = [...new Set(ids.filter(Boolean))]
  if (uniqueIds.length === 0) return
  const supabase = createClient()
  const { error } = await supabase.from("messages").delete().in("id", uniqueIds)
  if (error) {
    console.error("deleteMessageRows", error)
    throw new Error("旧回复删除失败，未开始重新生成。")
  }
}
