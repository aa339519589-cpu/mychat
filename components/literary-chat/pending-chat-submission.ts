import { isRecord } from '@/lib/unknown-value'
import { EnqueueJobError } from './job-stream-client'

const PENDING_DB = 'mychat-pending-chat-submissions'
const PENDING_STORE = 'submissions'
const PENDING_VERSION = 1
const LOCAL_PREFIX = 'mychat_pending_submission_'
const LOCAL_BODY_LIMIT = 700_000

export type PendingChatSubmission = {
  schemaVersion: 1
  conversationId: string
  generationId: string
  assistantMessageId: string
  path: '/api/chat'
  serializedBody: string
  createdAt: number
}

const memory = new Map<string, PendingChatSubmission>()
let databasePromise: Promise<IDBDatabase | null> | null = null

function localKey(conversationId: string): string {
  return `${LOCAL_PREFIX}${conversationId}`
}

function normalizeSubmission(value: unknown): PendingChatSubmission | null {
  if (!isRecord(value) || value.schemaVersion !== 1
    || typeof value.conversationId !== 'string'
    || typeof value.generationId !== 'string'
    || typeof value.assistantMessageId !== 'string'
    || value.path !== '/api/chat'
    || typeof value.serializedBody !== 'string'
    || !Number.isSafeInteger(value.createdAt)) return null
  try {
    const body: unknown = JSON.parse(value.serializedBody)
    if (!isRecord(body) || body.conversationId !== value.conversationId
      || body.generationId !== value.generationId
      || body.assistantMessageId !== value.assistantMessageId) return null
  } catch {
    return null
  }
  return value as PendingChatSubmission
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof window === 'undefined' || !window.indexedDB) return Promise.resolve(null)
  if (databasePromise) return databasePromise
  databasePromise = new Promise(resolve => {
    const request = window.indexedDB.open(PENDING_DB, PENDING_VERSION)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(PENDING_STORE)) {
        request.result.createObjectStore(PENDING_STORE, { keyPath: 'conversationId' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
    request.onblocked = () => resolve(null)
  })
  return databasePromise
}

function readLocal(conversationId: string): PendingChatSubmission | null {
  if (typeof window === 'undefined') return null
  try {
    return normalizeSubmission(JSON.parse(window.localStorage.getItem(localKey(conversationId)) ?? 'null'))
  } catch {
    return null
  }
}

function writeLocal(submission: PendingChatSubmission): void {
  if (typeof window === 'undefined') return
  try {
    if (submission.serializedBody.length <= LOCAL_BODY_LIMIT) {
      window.localStorage.setItem(localKey(submission.conversationId), JSON.stringify(submission))
    } else {
      window.localStorage.removeItem(localKey(submission.conversationId))
    }
  } catch {}
}

async function readIndexed(conversationId: string): Promise<PendingChatSubmission | null> {
  const database = await openDatabase()
  if (!database) return null
  return new Promise(resolve => {
    try {
      const request = database.transaction(PENDING_STORE, 'readonly')
        .objectStore(PENDING_STORE).get(conversationId)
      request.onsuccess = () => resolve(normalizeSubmission(request.result))
      request.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

async function writeIndexed(submission: PendingChatSubmission): Promise<void> {
  const database = await openDatabase()
  if (!database) return
  return new Promise(resolve => {
    try {
      const transaction = database.transaction(PENDING_STORE, 'readwrite')
      transaction.objectStore(PENDING_STORE).put(submission)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => resolve()
      transaction.onabort = () => resolve()
    } catch {
      resolve()
    }
  })
}

export async function savePendingChatSubmission(
  submission: PendingChatSubmission,
): Promise<void> {
  const normalized = normalizeSubmission(submission)
  if (!normalized) return
  memory.set(normalized.conversationId, normalized)
  writeLocal(normalized)
  await writeIndexed(normalized)
}

export async function readPendingChatSubmission(
  conversationId: string,
): Promise<PendingChatSubmission | null> {
  const indexed = await readIndexed(conversationId)
  const candidates = [indexed, readLocal(conversationId), memory.get(conversationId) ?? null]
    .filter((item): item is PendingChatSubmission => item !== null)
  const submission = candidates.sort((left, right) => right.createdAt - left.createdAt)[0] ?? null
  if (submission) memory.set(conversationId, submission)
  return submission
}

export async function removePendingChatSubmission(
  conversationId: string,
  generationId?: string,
): Promise<boolean> {
  const existing = await readPendingChatSubmission(conversationId)
  if (!existing || (generationId && existing.generationId !== generationId)) return false
  memory.delete(conversationId)
  if (typeof window !== 'undefined') {
    try { window.localStorage.removeItem(localKey(conversationId)) } catch {}
  }
  const database = await openDatabase()
  if (!database) return true
  await new Promise<void>(resolve => {
    try {
      const transaction = database.transaction(PENDING_STORE, 'readwrite')
      transaction.objectStore(PENDING_STORE).delete(conversationId)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => resolve()
      transaction.onabort = () => resolve()
    } catch {
      resolve()
    }
  })
  return true
}

export function pendingGenerationId(
  submission: PendingChatSubmission | null,
  fallback: string,
): string {
  return submission?.generationId ?? fallback
}

export async function removePermanentlyRejectedSubmission(
  conversationId: string,
  identity: { id: string } | null,
  error: unknown,
): Promise<void> {
  if (identity && error instanceof EnqueueJobError && !error.retryable) {
    await removePendingChatSubmission(conversationId, identity.id)
  }
}

export function pendingSubmissionBody(submission: PendingChatSubmission): Record<string, unknown> | null {
  try {
    const body: unknown = JSON.parse(submission.serializedBody)
    return isRecord(body) ? body : null
  } catch {
    return null
  }
}
