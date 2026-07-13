import type { Message } from "@/lib/chat-data"
import { hasInlineGeneratedMedia, normalizeGeneratedMediaList } from "@/lib/generated-media"

// ───────────── 本地消息缓存 ─────────────
// 目的：切换会话时有缓存就立刻返回，后台再刷新；不能让 UI 等 Supabase 慢查询。
// localStorage 太小，稍微带图/Artifact 就会爆，所以 IndexedDB 做主缓存，localStorage 只做兜底。
const MESSAGE_CACHE_PREFIX = "mychat_messages_"
const MESSAGE_CACHE_DB = "mychat-message-cache"
const MESSAGE_CACHE_STORE = "messages"
const MESSAGE_CACHE_VERSION = 1
export const MESSAGE_CACHE_LIMIT = 120
export const REMOTE_MESSAGE_LIMIT = 140
export const MESSAGE_CACHE_WARM_LIMIT = 8
const LOCAL_CACHE_LIMIT = 50
const LOCAL_CONTENT_LIMIT = 80_000

let dbPromise: Promise<IDBDatabase | null> | null = null

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

export function normalizeCachedMessages(value: unknown): Message[] {
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

export async function readCachedMessages(conversationId: string): Promise<Message[]> {
  const indexed = await readIndexedCachedMessages(conversationId)
  if (indexed.length) return indexed
  return readLocalCachedMessages(conversationId)
}

export function writeCachedMessages(conversationId: string, messages: Message[]) {
  const safe = normalizeCachedMessages(messages).slice(-MESSAGE_CACHE_LIMIT)
  if (!safe.length) return
  void writeIndexedCachedMessages(conversationId, safe)
  writeLocalCachedMessages(conversationId, safe)
}

export function cacheConversationMessages(conversationId: string, messages: Message[]) {
  writeCachedMessages(conversationId, messages)
}

export async function updateCachedMessageContent(conversationId: string, messageId: string, content: string) {
  const cached = await readCachedMessages(conversationId)
  if (!cached.length) return
  writeCachedMessages(conversationId, cached.map(m => m.id === messageId ? { ...m, content } : m))
}

export function removeCachedMessages(conversationId: string) {
  if (typeof window !== "undefined") {
    try { window.localStorage.removeItem(cacheKey(conversationId)) } catch {}
  }
  void removeIndexedCachedMessages(conversationId)
}

