import type { Message } from "@/lib/chat-data"
import { hasInlineGeneratedMedia, normalizeGeneratedMediaList } from "@/lib/generated-media"
import { generationTerminalWarning, normalizeMessageGeneration } from "@/lib/generation-message"
import { normalizeSearchNotes } from "@/lib/search-notes"
import { isRecord } from "@/lib/unknown-value"

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
let lastCommitTime = 0

export type CachedMessageSnapshot = {
  messages: Message[]
  ts: number
  commitId?: string
  totalCount?: number
  truncated?: boolean
}

type CacheCommit = { id: string; ts: number; totalCount: number }

function emptySnapshot(): CachedMessageSnapshot {
  return { messages: [], ts: 0 }
}

function cacheKey(conversationId: string) {
  return `${MESSAGE_CACHE_PREFIX}${conversationId}`
}

function cachedStatusFields(
  value: Record<string, unknown>,
  generation: Message['generation'],
): Pick<Message, 'isError' | 'outputWarning'> {
  return {
    isError: generation?.status === 'failed' || value.isError === true ? true : undefined,
    outputWarning: typeof value.outputWarning === 'string'
      ? value.outputWarning
      : generationTerminalWarning(generation),
  }
}

function cachedTextFields(
  value: Record<string, unknown>,
): Pick<Message, 'time' | 'ts' | 'thinking' | 'imageSummary'> {
  return {
    time: typeof value.time === 'string' ? value.time : '',
    ts: typeof value.ts === 'string' ? value.ts : undefined,
    thinking: typeof value.thinking === 'string' && value.thinking ? value.thinking : undefined,
    imageSummary: typeof value.imageSummary === 'string' ? value.imageSummary : undefined,
  }
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const strings = value.filter((item): item is string => typeof item === 'string')
  return strings.length ? strings : undefined
}

function normalizeCachedMessage(value: unknown): Message | null {
  if (!isRecord(value) || typeof value.id !== "string") return null
  if (value.role !== "user" && value.role !== "assistant") return null
  if (typeof value.content !== "string") return null
  const media = normalizeGeneratedMediaList(value.media)
  const generation = normalizeMessageGeneration(value.generation)
  const searchNotes = normalizeSearchNotes(value.searchNotes)
  return {
    id: value.id,
    role: value.role,
    content: value.content,
    ...cachedTextFields(value),
    ...cachedStatusFields(value, generation),
    images: stringArray(value.images),
    media: media.length ? media : undefined,
    memoryNotes: stringArray(value.memoryNotes),
    files: stringArray(value.files),
    searchNotes: searchNotes.length ? searchNotes : undefined,
    generation,
  }
}

export function normalizeCachedMessages(value: unknown): Message[] {
  if (!Array.isArray(value)) return []
  return value.map(normalizeCachedMessage).filter((m): m is Message => !!m)
}

export function mergeCachedMessages(existing: Message[], incoming: Message[]): Message[] {
  const previousById = new Map(existing.map(message => [message.id, message]))
  return incoming.map(message => {
    const previous = previousById.get(message.id)
    const previousGeneration = previous?.generation
    const incomingGeneration = message.generation
    const incomingIsOlder = previousGeneration && (
      !incomingGeneration
      || (incomingGeneration.id === previousGeneration.id
        && incomingGeneration.sequence < previousGeneration.sequence)
    )
    if (!previous || !previousGeneration || !incomingIsOlder) return message
    return {
      ...message,
      content: previous.content,
      thinking: previous.thinking,
      media: previous.media,
      isError: previous.isError,
      outputWarning: previous.outputWarning,
      generation: previousGeneration,
    }
  })
}

export function mergeCachedMessageSnapshots(
  indexed: CachedMessageSnapshot,
  local: CachedMessageSnapshot,
): Message[] {
  if (!indexed.messages.length && !local.messages.length) return []
  if (!indexed.messages.length) {
    const indexedIsAuthoritativeEmpty = Boolean(
      indexed.commitId
      && indexed.truncated === false
      && indexed.ts >= local.ts,
    )
    return indexedIsAuthoritativeEmpty ? [] : local.messages
  }
  if (!local.messages.length) {
    const localIsAuthoritativeEmpty = Boolean(
      local.commitId
      && local.truncated === false
      && local.ts >= indexed.ts,
    )
    return localIsAuthoritativeEmpty ? [] : indexed.messages
  }
  if (indexed.commitId && indexed.commitId === local.commitId) {
    return mergeCachedMessages(local.messages, indexed.messages)
  }
  const [older, newer] = indexed.ts <= local.ts
    ? [indexed, local]
    : [local, indexed]
  const resolvedNewer = mergeCachedMessages(older.messages, newer.messages)
  const resolvedById = new Map([
    ...older.messages.map(message => [message.id, message] as const),
    ...resolvedNewer.map(message => [message.id, message] as const),
  ])
  if (newer.commitId && newer.truncated === false) return resolvedNewer

  const newerIds = new Set(newer.messages.map(message => message.id))
  if (newer.commitId && newer.truncated && newer.totalCount) {
    const firstShared = older.messages.findIndex(message => newerIds.has(message.id))
    const candidates = (firstShared >= 0
      ? older.messages.slice(0, firstShared)
      : older.messages.filter(message => !newerIds.has(message.id)))
    const needed = Math.max(0, newer.totalCount - newer.messages.length)
    const orderedIds = [
      ...candidates.slice(-needed).map(message => message.id),
      ...newer.messages.map(message => message.id),
    ]
    return orderedIds.map(id => resolvedById.get(id)!).filter(Boolean)
  }

  // Legacy entries had no commit metadata. Preserve the longer snapshot's
  // chronological order and place only genuinely newer extras at the tail.
  const backbone = indexed.messages.length >= local.messages.length ? indexed : local
  const secondary = backbone === indexed ? local : indexed
  const backboneIds = new Set(backbone.messages.map(message => message.id))
  const extras = secondary.messages.filter(message => !backboneIds.has(message.id))
  const orderedIds = secondary.ts <= backbone.ts
    ? [...extras.map(message => message.id), ...backbone.messages.map(message => message.id)]
    : [...backbone.messages.map(message => message.id), ...extras.map(message => message.id)]
  return orderedIds.map(id => resolvedById.get(id)!).filter(Boolean)
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

function readLocalCachedSnapshot(conversationId: string): CachedMessageSnapshot {
  if (typeof window === "undefined") return emptySnapshot()
  try {
    const raw = window.localStorage.getItem(cacheKey(conversationId))
    if (!raw) return emptySnapshot()
    const parsed: unknown = JSON.parse(raw)
    const record = isRecord(parsed) ? parsed : null
    const messages = normalizeCachedMessages(Array.isArray(parsed) ? parsed : record?.messages)
    if (messages.some(message => hasInlineGeneratedMedia(message.media))) {
      window.localStorage.removeItem(cacheKey(conversationId))
      return emptySnapshot()
    }
    return {
      messages,
      ts: typeof record?.ts === "number" && Number.isSafeInteger(record.ts) && record.ts >= 0 ? record.ts : 0,
      commitId: typeof record?.commitId === "string" ? record.commitId : undefined,
      totalCount: typeof record?.totalCount === "number" && Number.isSafeInteger(record.totalCount) && record.totalCount >= messages.length
        ? record.totalCount
        : undefined,
      truncated: typeof record?.truncated === "boolean" ? record.truncated : undefined,
    }
  } catch {
    return emptySnapshot()
  }
}

function writeLocalCachedMessages(conversationId: string, messages: Message[], commit: CacheCommit) {
  if (typeof window === "undefined") return
  const merged = mergeCachedMessages(readLocalCachedSnapshot(conversationId).messages, messages)
  if (merged.some(message => hasInlineGeneratedMedia(message.media))) {
    try { window.localStorage.removeItem(cacheKey(conversationId)) } catch {}
    return
  }
  const write = (count: number, limit: number) => {
    const payload = {
      version: 2,
      ts: commit.ts,
      commitId: commit.id,
      totalCount: commit.totalCount,
      truncated: merged.length > count,
      messages: merged.slice(-count).map(m => ({
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

async function readIndexedCachedSnapshot(conversationId: string): Promise<CachedMessageSnapshot> {
  const db = await openCacheDb()
  if (!db) return emptySnapshot()
  return new Promise(resolve => {
    try {
      const tx = db.transaction(MESSAGE_CACHE_STORE, "readonly")
      const req = tx.objectStore(MESSAGE_CACHE_STORE).get(conversationId)
      req.onsuccess = () => resolve({
        messages: normalizeCachedMessages(req.result?.messages),
        ts: Number.isSafeInteger(req.result?.ts) && req.result.ts >= 0 ? req.result.ts : 0,
        commitId: typeof req.result?.commitId === "string" ? req.result.commitId : undefined,
        totalCount: Number.isSafeInteger(req.result?.totalCount) ? req.result.totalCount : undefined,
        truncated: req.result?.truncated === false ? false : undefined,
      })
      req.onerror = () => resolve(emptySnapshot())
    } catch {
      resolve(emptySnapshot())
    }
  })
}

async function writeIndexedCachedMessages(
  conversationId: string,
  messages: Message[],
  commit: CacheCommit,
): Promise<void> {
  const db = await openCacheDb()
  if (!db) return
  return new Promise(resolve => {
    try {
      const tx = db.transaction(MESSAGE_CACHE_STORE, "readwrite")
      const store = tx.objectStore(MESSAGE_CACHE_STORE)
      const request = store.get(conversationId)
      const put = (existing: unknown) => {
        store.put({
          conversationId,
          ts: commit.ts,
          commitId: commit.id,
          totalCount: commit.totalCount,
          truncated: false,
          messages: mergeCachedMessages(
            normalizeCachedMessages(isRecord(existing) ? existing.messages : undefined),
            normalizeCachedMessages(messages),
          ).slice(-MESSAGE_CACHE_LIMIT),
        })
      }
      request.onsuccess = () => put(request.result)
      request.onerror = () => put(undefined)
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
  const [indexed, local] = await Promise.all([
    readIndexedCachedSnapshot(conversationId),
    Promise.resolve(readLocalCachedSnapshot(conversationId)),
  ])
  return mergeCachedMessageSnapshots(indexed, local)
}

export async function writeCachedMessages(conversationId: string, messages: Message[]) {
  const safe = normalizeCachedMessages(messages).slice(-MESSAGE_CACHE_LIMIT)
  const now = Date.now()
  lastCommitTime = Math.max(now, lastCommitTime + 1)
  const commit: CacheCommit = {
    id: `${lastCommitTime}-${crypto.randomUUID()}`,
    ts: lastCommitTime,
    totalCount: safe.length,
  }
  writeLocalCachedMessages(conversationId, safe, commit)
  await writeIndexedCachedMessages(conversationId, safe, commit)
}

export function cacheConversationMessages(conversationId: string, messages: Message[]) {
  void writeCachedMessages(conversationId, messages)
}

export async function updateCachedMessageContent(conversationId: string, messageId: string, content: string) {
  const cached = await readCachedMessages(conversationId)
  if (!cached.length) return
  await writeCachedMessages(conversationId, cached.map(m => m.id === messageId ? { ...m, content } : m))
}

export function removeCachedMessages(conversationId: string) {
  if (typeof window !== "undefined") {
    try { window.localStorage.removeItem(cacheKey(conversationId)) } catch {}
  }
  void removeIndexedCachedMessages(conversationId)
}
