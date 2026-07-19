import type { Message } from "@/lib/chat-data"
import type { HistoryMessage } from "./chat-stream-service"

export function toHistoryMessage(message: Message): HistoryMessage {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    ...(message.images?.length ? { images: message.images } : {}),
    ...(message.imageSummary ? { imageSummary: message.imageSummary } : {}),
    // Browser clocks are not persistence authority. Omitting ts makes the API
    // assign one server-side turn time, preventing a user row from sorting
    // behind its own assistant row after leaving and reopening the page.
  }
}
