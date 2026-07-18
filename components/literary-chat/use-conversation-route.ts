"use client"

import { useCallback, useEffect, useRef, useState } from "react"

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
  const historyWriteRevisionRef = useRef(0)

  useEffect(() => {
    const syncFromHistory = () => {
      historyWriteRevisionRef.current += 1
      setConversationId(currentConversationId())
    }
    window.addEventListener("popstate", syncFromHistory)
    return () => window.removeEventListener("popstate", syncFromHistory)
  }, [])

  const update = useCallback((id: string | null, replace = false) => {
    const path = conversationPath(id)
    const revision = ++historyWriteRevisionRef.current

    // Commit the in-app route immediately. Next patches native history writes,
    // so deferring that bookkeeping keeps New Chat and conversation switches
    // off the click-to-paint critical path.
    setConversationId(id)
    window.setTimeout(() => {
      if (historyWriteRevisionRef.current !== revision) return
      if (window.location.pathname !== path || window.location.search) {
        window.history[replace ? "replaceState" : "pushState"]({ conversationId: id }, "", path)
      }
    }, 0)
  }, [])

  return {
    routeConversationId: conversationId,
    openConversation: (id: string | null) => update(id),
    replaceConversation: (id: string | null) => update(id, true),
  }
}
