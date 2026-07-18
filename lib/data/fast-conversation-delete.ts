import { deleteConversationRow as deleteConversationRowAndWait } from "./conversations"

const pendingDeletes = new Map<string, Promise<void>>()
const RETRY_DELAYS_MS = [0, 400, 1_200] as const

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function persistConversationDelete(id: string): Promise<void> {
  let lastError: unknown
  for (const retryDelay of RETRY_DELAYS_MS) {
    if (retryDelay > 0) await delay(retryDelay)
    try {
      await deleteConversationRowAndWait(id)
      return
    } catch (error) {
      lastError = error
    }
  }
  console.error("[mychat/conversations] background deletion failed", { conversationId: id, error: lastError })
}

/**
 * Keep deletion latency off the interaction path. The caller can update the UI
 * immediately while the durable delete is retried in the background.
 */
export function deleteConversationRow(id: string): Promise<void> {
  if (!pendingDeletes.has(id)) {
    const request = persistConversationDelete(id).finally(() => pendingDeletes.delete(id))
    pendingDeletes.set(id, request)
  }
  return Promise.resolve()
}
