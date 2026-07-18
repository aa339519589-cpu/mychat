import type { Message } from "@/lib/chat-data"
import { createClient } from "@/lib/supabase/client"
import { normalizeMessageRow, type MessageRow } from "./conversation-rows"
import { readCachedMessages, REMOTE_MESSAGE_LIMIT, writeCachedMessages } from "./message-cache"
import { reconcileRemoteMessages } from "./remote-message-reconciliation"

async function fetchFreshRemoteMessages(conversationId: string): Promise<Message[]> {
  const supabase = createClient()
  const { data, error } = await supabase
    .from("messages")
    .select("id, role, content, images, thinking, created_at")
    .eq("conversation_id", conversationId)
    // User timestamps may originate on the device. Clock skew can therefore put
    // an assistant row before its user row after reload. `seq` is database-owned.
    .order("seq", { ascending: false })
    .limit(REMOTE_MESSAGE_LIMIT)

  if (error) throw new Error("消息同步暂时不可用", { cause: error })
  if (!data) throw new Error("消息同步响应无效")
  return (data as MessageRow[]).map(normalizeMessageRow).reverse()
}

/** Fresh cloud hydration that never lets a lagging read erase a locally accepted turn. */
export async function fetchReliableMessages(conversationId: string): Promise<Message[]> {
  const cached = await readCachedMessages(conversationId)
  const remote = await fetchFreshRemoteMessages(conversationId)
  const reconciled = reconcileRemoteMessages(cached, remote)
  await writeCachedMessages(conversationId, reconciled)
  return reconciled
}
