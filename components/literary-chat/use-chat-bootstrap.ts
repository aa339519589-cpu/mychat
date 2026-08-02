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
  fetchModelEndpoints,
  fetchProfile,
  fetchProjects,
  lastExcerpt,
} from "@/lib/data"
import { readCachedMessages } from "@/lib/data/message-cache"
import { fetchReliableMessages } from "@/lib/data/reliable-messages"
import { reconcileRemoteMessages } from "@/lib/data/remote-message-reconciliation"
import { restoreModelEndpointsWhenAvailable } from "./model-endpoint-restoration"

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

function restoreModelEndpoints(
  model: ChatBootstrapOptions['model'],
  isCancelled: () => boolean,
) {
  restoreModelEndpointsWhenAvailable({
    fetchEndpoints: fetchModelEndpoints,
    restore: model.restore,
    isCancelled,
  })
}

async function applyCachedMessages(
  conversationId: string,
  setConversations: Dispatch<SetStateAction<Conversation[]>>,
  loadedRef: MutableRefObject<Set<string>>,
): Promise<boolean> {
  const cached = await readCachedMessages(conversationId)
  if (!cached.length) return false
  loadedRef.current.add(conversationId)
  setConversations(previous => previous.map(conversation => {
    if (conversation.id !== conversationId) return conversation
    if (conversation.messages.length >= cached.length) return conversation
    const merged = reconcileRemoteMessages(conversation.messages, cached)
    return {
      ...conversation,
      messages: merged,
      excerpt: lastExcerpt(merged),
    }
  }))
  return true
}

function createBlankDraft(): Conversation {
  return {
    id: crypto.randomUUID(),
    title: "未命名的篇章",
    excerpt: "",
    date: "今日",
    messages: [],
    draft: true,
  }
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
      restoreModelEndpoints(model, cancelled)
      const [rows, memories, profile, projects] = await Promise.all([
        fetchConversations(),
        fetchMemories(),
        fetchProfile(),
        fetchProjects(),
      ])
      if (cancelled()) return
      memory.restore(memories, profile.memoryEnabled)
      project.set(projects)
      for (const row of rows) if (row.msgCount === 0) {
        void deleteConversationRow(row.id).catch(() => undefined)
      }
      const history = rows.filter(row => row.msgCount !== 0)

      // Explicit deep link keeps that conversation. Otherwise cold start /
      // reopen always lands on a blank draft — never the last history chat.
      const requested = routeConversationId
        ? history.find(row => row.id === routeConversationId)
        : undefined

      if (requested) {
        rootConversationIdRef.current = requested.id
        draftIdRef.current = null
        setConversations(history)
        setActiveId(requested.id)
        replaceConversation(requested.id)
        await applyCachedMessages(requested.id, setConversations, loadedRef)
        if (cancelled()) return
        setReady(true)
        void synchronizeConversationState({
          hydrate: async () => {
            const messages = await fetchReliableMessages(requested.id)
            if (cancelled()) return
            loadedRef.current.add(requested.id)
            setConversations(previous => previous.map(conversation => {
              if (conversation.id !== requested.id) return conversation
              const merged = reconcileRemoteMessages(conversation.messages, messages)
              return {
                ...conversation,
                messages: merged,
                excerpt: lastExcerpt(merged),
              }
            }))
          },
          reconcile: () => onConversationHydrated?.(requested.id) ?? Promise.resolve(true),
          isCancelled: cancelled,
        }).catch(() => undefined)
        return
      }

      const draft = createBlankDraft()
      draftIdRef.current = draft.id
      rootConversationIdRef.current = draft.id
      setConversations([draft, ...history])
      setActiveId(draft.id)
      replaceConversation(null)
      setReady(true)
    })()
  })

  useEffect(() => {
    let cancelled = false
    initialize(user, () => cancelled)
    return () => { cancelled = true }
  }, [user])

  return ready
}
