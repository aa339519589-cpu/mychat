import type { Conversation } from "@/lib/chat-data"

export type SidebarAnchor = { top: number; bottom: number; right: number }

export function sortConversations(conversations: Conversation[]): Conversation[] {
  return [...conversations].sort((left, right) => Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)))
}
