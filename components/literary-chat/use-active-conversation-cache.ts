"use client"

import { useEffect, type MutableRefObject } from "react"
import type { Conversation } from "@/lib/chat-data"
import { cacheConversationMessages } from "@/lib/data"

export function useActiveConversationCache(
  active: Conversation | undefined,
  activeId: string,
  conversationsRef: MutableRefObject<Conversation[]>,
) {
  useEffect(() => {
    if (!active?.messages.length) return
    const timer = window.setTimeout(() => {
      cacheConversationMessages(active.id, active.messages)
    }, 350)
    return () => window.clearTimeout(timer)
  }, [active?.id, active?.messages])

  useEffect(() => {
    const persist = () => {
      const conversation = conversationsRef.current.find(item => item.id === activeId)
      if (conversation?.messages.length) cacheConversationMessages(conversation.id, conversation.messages)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") persist()
    }
    window.addEventListener("pagehide", persist)
    document.addEventListener("visibilitychange", onVisibilityChange)
    return () => {
      window.removeEventListener("pagehide", persist)
      document.removeEventListener("visibilitychange", onVisibilityChange)
      persist()
    }
  }, [activeId, conversationsRef])
}
