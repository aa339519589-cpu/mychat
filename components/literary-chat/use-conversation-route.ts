"use client"

import { useCallback, useEffect, useState } from "react"

const CONVERSATION_PATH = /^\/c\/([^/]+)\/?$/

export function conversationIdFromPath(pathname: string): string | null {
  const match = pathname.match(CONVERSATION_PATH)
  if (!match) return null
  try {
    const id = decodeURIComponent(match[1]).trim()
    return id || null
  } catch {
    return null
  }
}

export function conversationPath(id: string | null): string {
  return id ? `/c/${encodeURIComponent(id)}` : "/"
}

function currentConversationId(): string | null {
  return typeof window === "undefined" ? null : conversationIdFromPath(window.location.pathname)
}

export function useConversationRoute() {
  const [conversationId, setConversationId] = useState<string | null>(currentConversationId)

  useEffect(() => {
    const syncFromHistory = () => setConversationId(currentConversationId())
    window.addEventListener("popstate", syncFromHistory)
    return () => window.removeEventListener("popstate", syncFromHistory)
  }, [])

  const update = useCallback((id: string | null, replace = false) => {
    const path = conversationPath(id)
    if (window.location.pathname !== path || window.location.search) {
      // Next patches the native history methods and copies its private router state.
      // Passing custom data (instead of cloning __NA) keeps its canonical URL in sync.
      window.history[replace ? "replaceState" : "pushState"]({ conversationId: id }, "", path)
    }
    setConversationId(id)
  }, [])

  return {
    routeConversationId: conversationId,
    openConversation: (id: string | null) => update(id),
    replaceConversation: (id: string | null) => update(id, true),
  }
}
