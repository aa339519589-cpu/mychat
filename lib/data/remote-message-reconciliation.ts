import type { Message } from "@/lib/chat-data"
import { mergeCachedMessages } from "./message-cache"

function timestamp(message: Message): number | null {
  if (!message.ts) return null
  const value = Date.parse(message.ts)
  return Number.isFinite(value) ? value : null
}

function mergeRemoteMessage(previous: Message | undefined, incoming: Message): Message {
  if (!previous) return incoming
  const merged = mergeCachedMessages([previous], [incoming])[0] ?? incoming

  // The authoritative enqueue writes an empty assistant placeholder before the
  // worker finishes. A fresh read must not erase a newer locally streamed prefix.
  if (incoming.role === "assistant"
    && !incoming.generation
    && incoming.content.length === 0
    && previous.content.length > 0) {
    return {
      ...merged,
      content: previous.content,
      thinking: previous.thinking,
      media: previous.media,
      isError: previous.isError,
      outputWarning: previous.outputWarning,
    }
  }

  return merged
}

function pendingFirstTurn(existing: Message[]): boolean {
  if (existing.length < 2) return false
  const assistant = existing.at(-1)
  const user = existing.at(-2)
  if (!assistant || !user || user.role !== "user" || assistant.role !== "assistant") return false
  if (assistant.generation) return false
  return timestamp(user) !== null
}

/**
 * Reconcile a fresh remote window without dropping a newer optimistic/local tail.
 * Remote rows remain authoritative for shared IDs and intentional deletions; only
 * messages appended after the last shared row are retained when their timestamp
 * is at least as new as the newest remote row.
 */
export function reconcileRemoteMessages(existing: Message[], incoming: Message[]): Message[] {
  const previousById = new Map(existing.map(message => [message.id, message]))
  const mergedRemote = incoming.map(message => mergeRemoteMessage(previousById.get(message.id), message))

  if (incoming.length === 0) {
    return pendingFirstTurn(existing) ? existing : []
  }

  const incomingIds = new Set(incoming.map(message => message.id))
  let lastSharedIndex = -1
  for (let index = existing.length - 1; index >= 0; index--) {
    if (incomingIds.has(existing[index].id)) {
      lastSharedIndex = index
      break
    }
  }

  const localTail = existing.slice(lastSharedIndex + 1).filter(message => !incomingIds.has(message.id))
  if (localTail.length === 0) return mergedRemote

  const newestRemoteTimestamp = incoming.reduce<number | null>((latest, message) => {
    const value = timestamp(message)
    return value === null ? latest : latest === null ? value : Math.max(latest, value)
  }, null)
  const firstLocalTimestamp = localTail.reduce<number | null>((earliest, message) => {
    const value = timestamp(message)
    return value === null ? earliest : earliest === null ? value : Math.min(earliest, value)
  }, null)

  const localTailIsNewer = newestRemoteTimestamp === null
    || (firstLocalTimestamp !== null && firstLocalTimestamp >= newestRemoteTimestamp)

  return localTailIsNewer ? [...mergedRemote, ...localTail] : mergedRemote
}
