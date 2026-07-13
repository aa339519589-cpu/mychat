import type { Message } from "@/lib/chat-data"
import type { HistoryMessage } from "./chat-stream-service"

export function toHistoryMessage(message: Message): HistoryMessage {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    ...(message.images?.length ? { images: message.images } : {}),
    ...(message.imageSummary ? { imageSummary: message.imageSummary } : {}),
    ...(message.ts ? { ts: message.ts } : {}),
  }
}
