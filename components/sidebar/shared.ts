import type { CSSProperties } from "react"
import type { Conversation } from "@/lib/chat-data"

export type SidebarAnchor = { top: number; bottom: number; right: number }
export type SidebarScreen = "settings" | "projects" | "project-detail"

const SIDEBAR_SCREEN_Z: Record<SidebarScreen, number> = { settings: 20, projects: 20, "project-detail": 30 }

export function sidebarScreenStyle(stack: SidebarScreen[], screen: SidebarScreen): CSSProperties {
  return { zIndex: SIDEBAR_SCREEN_Z[screen], pointerEvents: stack.includes(screen) ? "auto" : "none" }
}

export function sortConversations(conversations: Conversation[]): Conversation[] {
  return [...conversations].sort((left, right) => Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)))
}
