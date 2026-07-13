"use client"

import { useEffect, useEffectEvent, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react"
import type { User } from "@supabase/supabase-js"
import type { Conversation } from "@/lib/chat-data"
import type { Memory } from "@/lib/memory-data"
import type { ModelEndpointSummary } from "@/lib/model-endpoints"
import type { Project } from "@/lib/project-data"
import { synchronizeConversationState } from "./conversation-synchronization"
import {
  deleteConversationRow,
  ensureProfile,
  fetchConversations,
  fetchMemories,
  fetchMessages,
  fetchModelEndpoints,
  fetchProfile,
  fetchProjects,
  lastExcerpt,
  mergeCachedMessages,
} from "@/lib/data"

type ChatBootstrapOptions = {
  user: User | null
  routeConversationId: string | null
  replaceConversation: (id: string | null) => void
  setConversations: Dispatch<SetStateAction<Conversation[]>>
  setActiveId: Dispatch<SetStateAction<string>>
  loadedRef: MutableRefObject<Set<string>>
  draftIdRef: MutableRefObject<string | null>
  rootConversationIdRef: MutableRefObject<string | null>
  memory: {
    restore: (items: Memory[], enabled: boolean) => void
    reset: () => void
  }
  project: { set: Dispatch<SetStateAction<Project[]>>; reset: () => void }
  model: { restore: (items: ModelEndpointSummary[]) => void; reset: () => void }
  onConversationHydrated?: (id: string) => Promise<boolean>
}

export function useChatBootstrap({
  user,
  routeConversationId,
  replaceConversation,
  setConversations,
  setActiveId,
  loadedRef,
  draftIdRef,
  rootConversationIdRef,
  memory,
  project,
  model,
  onConversationHydrated,
}: ChatBootstrapOptions) {
  const [ready, setReady] = useState(false)

  const initialize = useEffectEvent((currentUser: User | null, cancelled: () => boolean) => {
    setReady(false)
    if (!currentUser) {
      setConversations([])
      memory.reset()
      setActiveId("")
      project.reset()
      model.reset()
      draftIdRef.current = null
      rootConversationIdRef.current = null
      loadedRef.current = new Set()
      return
    }

    void (async () => {
      ensureProfile(currentUser.id)
      const [rows, memories, profile, projects, endpoints] = await Promise.all([
        fetchConversations(),
        fetchMemories(),
        fetchProfile(),
        fetchProjects(),
        fetchModelEndpoints().catch(() => []),
      ])
      if (cancelled()) return
      memory.restore(memories, profile.memoryEnabled)
      project.set(projects)
      model.restore(endpoints)
      for (const row of rows) if (row.msgCount === 0) {
        void deleteConversationRow(row.id).catch(() => undefined)
      }
      const conversations = rows.filter(row => row.msgCount !== 0)

      if (conversations.length === 0) {
        const id = crypto.randomUUID()
        const draft: Conversation = { id, title: "未命名的篇章", excerpt: "", date: "今日", messages: [], draft: true }
        draftIdRef.current = id
        rootConversationIdRef.current = id
        setConversations([draft])
        setActiveId(id)
        replaceConversation(null)
        setReady(true)
        return
      }

      const requested = conversations.find(row => row.id === routeConversationId)
      const selected = requested ?? conversations[0]
      rootConversationIdRef.current = conversations[0].id
      setConversations(conversations)
      setActiveId(selected.id)
      replaceConversation(selected.id)
      const reconciled = await synchronizeConversationState({
        hydrate: async () => {
          const messages = await fetchMessages(selected.id, { fresh: true })
          if (cancelled()) return
          loadedRef.current.add(selected.id)
          setConversations(previous => previous.map(conversation => conversation.id === selected.id
            ? {
              ...conversation,
              messages: mergeCachedMessages(conversation.messages, messages),
              excerpt: lastExcerpt(messages),
            }
            : conversation))
        },
        reconcile: () => onConversationHydrated?.(selected.id) ?? Promise.resolve(true),
        isCancelled: cancelled,
      })
      if (cancelled()) return
      setReady(reconciled)
    })()
  })

  useEffect(() => {
    let cancelled = false
    initialize(user, () => cancelled)
    return () => { cancelled = true }
  }, [user])

  return ready
}
