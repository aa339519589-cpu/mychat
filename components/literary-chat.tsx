"use client"

import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react"
import type { Conversation } from "@/lib/chat-data"
import type { SearchMode } from "@/lib/search-mode"
import {
  cacheConversationMessages,
  deleteConversationRow,
  lastExcerpt,
  setConversationPinned,
  setConversationProject,
  setConversationStarred,
  updateConversationTitle,
} from "@/lib/data"
import { fetchReliableMessages } from "@/lib/data/reliable-messages"
import { reconcileRemoteMessages } from "@/lib/data/remote-message-reconciliation"
import { createClient } from "@/lib/supabase/client"
import { LoginScreen } from "@/components/login-screen"
import type { AppSidebarProps } from "@/components/app-sidebar"
import { useAuthUser } from "@/components/literary-chat/use-auth-user"
import { useChatBootstrap } from "@/components/literary-chat/use-chat-bootstrap"
import { useChatGeneration } from "@/components/literary-chat/use-chat-generation"
import { useConversationRoute } from "@/components/literary-chat/use-conversation-route"
import { synchronizeConversationState } from "@/components/literary-chat/conversation-synchronization"
import { useLiteraryChatLayoutState } from "@/components/literary-chat/layout-state"
import { useMemories } from "@/components/literary-chat/use-memories"
import { useModelSelection } from "@/components/literary-chat/use-model-selection"
import { useProjects } from "@/components/literary-chat/use-projects"
import {
  LiteraryChatView,
  type LiteraryChatViewController,
} from "@/components/literary-chat/literary-chat-view"

const EMPTY_DRAFT_TITLE = "未命名的篇章"

function createDraft(id: string, projectId?: string): Conversation {
  return { id, title: EMPTY_DRAFT_TITLE, excerpt: "", date: "今日", messages: [], draft: true, projectId }
}

export function LiteraryChat() {
  const { user, setUser, authChecked } = useAuthUser()
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState("")
  const [hydratingConversationId, setHydratingConversationId] = useState<string | null>(null)
  const [searchMode, setSearchMode] = useState<SearchMode>("off")
  const [deepResearch, setDeepResearch] = useState(false)
  const [historyRetrieval, setHistoryRetrieval] = useState(false)
  const layout = useLiteraryChatLayoutState()
  const route = useConversationRoute()
  const loadedRef = useRef<Set<string>>(new Set())
  const draftIdRef = useRef<string | null>(null)
  const rootConversationIdRef = useRef<string | null>(null)
  const conversationsRef = useRef(conversations)
  const activeIdRef = useRef(activeId)
  const resumeHydratedRef = useRef<(id: string) => Promise<boolean>>(() => Promise.resolve(false))
  const activationTokenRef = useRef(0)
  conversationsRef.current = conversations
  activeIdRef.current = activeId

  const memory = useMemories(user)
  const model = useModelSelection({ setSearchMode, setDeepResearch, setHistoryRetrieval })
  const project = useProjects({
    user,
    draftIdRef,
    setActiveId,
    setConversations,
    setDrawerOpen: layout.setDrawerOpen,
  })
  const workspaceReady = useChatBootstrap({
    user,
    routeConversationId: route.routeConversationId,
    replaceConversation: route.replaceConversation,
    setConversations,
    setActiveId,
    loadedRef,
    draftIdRef,
    rootConversationIdRef,
    memory: { restore: memory.restoreMemories, reset: memory.resetMemories },
    project: { set: project.setProjects, reset: project.resetProjects },
    model: { restore: model.restoreModelSelection, reset: model.resetModelEndpoints },
    onConversationHydrated: id => resumeHydratedRef.current(id),
  })

  const handleGitHubCallback = useEffectEvent(() => {
    const github = new URLSearchParams(window.location.search).get("github")
    if (!github) return
    if (github === "connected") layout.setCodeOpen(true)
    route.replaceConversation(route.routeConversationId)
  })
  useEffect(() => {
    handleGitHubCallback()
  }, [])

  const active = useMemo(
    () => conversations.find(conversation => conversation.id === activeId),
    [conversations, activeId],
  )
  const authorityReady = workspaceReady && hydratingConversationId !== activeId
  const generation = useChatGeneration({
    user,
    active,
    activeId,
    activeTier: model.activeTier,
    activeEndpoint: model.activeEndpoint,
    activeEndpointId: model.activeEndpointId,
    memories: memory.memories,
    memoryEnabled: memory.memoryEnabled,
    searchMode,
    deepResearch,
    historyRetrieval,
    authorityReady,
    setActiveId,
    setConversations,
    setMemories: memory.setMemories,
    setOpenArtifactId: layout.setOpenArtifactId,
    loadedRef,
    draftIdRef,
    getProjectContext: project.getProjectContext,
    onConversationCreated: id => {
      const pendingDraft = conversationsRef.current.find(conversation => (
        conversation.draft && conversation.id !== id && conversation.messages.length === 0
      ))
      draftIdRef.current = pendingDraft?.id ?? null
      // A delayed enqueue acknowledgement must never pull the user out of a
      // newer chat they already opened.
      if (activeIdRef.current !== id) return
      rootConversationIdRef.current = id
      route.replaceConversation(id)
    },
  })
  resumeHydratedRef.current = id => generation.resumeGenerationIfNeeded(id)

  const activeProject = useMemo(
    () => project.projects.find(item => item.id === active?.projectId) ?? null,
    [project.projects, active?.projectId],
  )
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = scrollRef.current
    if (element) element.scrollTo({ top: element.scrollHeight, behavior: "smooth" })
  }, [active?.messages?.length, activeId])

  // Keep a recent local snapshot while streaming, and force one whenever the
  // user leaves the conversation, backgrounds the app, or closes the page.
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
  }, [activeId])

  async function activateConversation(id: string) {
    const activationToken = ++activationTokenRef.current
    setActiveId(id)
    setHydratingConversationId(id)
    layout.setDrawerOpen(false)
    layout.setOpenArtifactId(null)
    const locallyRunning = generation.generationByConversation[id]?.status === "running"
    const reconciled = await synchronizeConversationState({
      hydrate: locallyRunning ? async () => undefined : async () => {
        const messages = await fetchReliableMessages(id)
        loadedRef.current.add(id)
        setConversations(previous => previous.map(conversation => {
          if (conversation.id !== id) return conversation
          const merged = reconcileRemoteMessages(conversation.messages, messages)
          return {
            ...conversation,
            messages: merged,
            excerpt: lastExcerpt(merged),
          }
        }))
      },
      reconcile: () => generation.resumeGenerationIfNeeded(id),
      isCancelled: () => activationTokenRef.current !== activationToken,
    })
    if (reconciled) setHydratingConversationId(current => current === id ? null : current)
  }

  function handleSelect(id: string) {
    const conversation = conversationsRef.current.find(item => item.id === id)
    route.openConversation(conversation?.draft ? null : id)
    void activateConversation(id)
  }

  const syncConversationRoute = useEffectEvent(() => {
    if (!workspaceReady) return
    const items = conversationsRef.current
    const target = route.routeConversationId
      ? items.find(item => !item.draft && item.id === route.routeConversationId)
      : items.find(item => item.id === rootConversationIdRef.current)
    if (target) {
      if (target.id !== activeId) void activateConversation(target.id)
      return
    }
    const fallback = items.find(item => !item.draft) ?? items[0]
    if (!fallback) return
    rootConversationIdRef.current = fallback.id
    route.replaceConversation(fallback.draft ? null : fallback.id)
    if (fallback.id !== activeId) void activateConversation(fallback.id)
  })
  useEffect(() => {
    syncConversationRoute()
  }, [route.routeConversationId, workspaceReady])

  async function handleDelete(id: string) {
    const task = generation.generationByConversation[id]
    if (task?.status === "running" || hydratingConversationId === id) {
      console.warn("[mychat/generation] active conversation deletion blocked", { conversationId: id })
      return
    }
    try {
      await deleteConversationRow(id)
    } catch {
      return
    }
    loadedRef.current.delete(id)
    if (draftIdRef.current === id) draftIdRef.current = null
    const remaining = conversationsRef.current.filter(conversation => conversation.id !== id)
    if (remaining.length === 0) {
      const draftId = crypto.randomUUID()
      draftIdRef.current = draftId
      rootConversationIdRef.current = draftId
      setConversations([createDraft(draftId)])
      setActiveId(draftId)
      activationTokenRef.current += 1
      setHydratingConversationId(null)
      route.replaceConversation(null)
      return
    }
    setConversations(remaining)
    if (activeId !== id) return
    const next = remaining.find(conversation => !conversation.draft) ?? remaining[0]
    rootConversationIdRef.current = next.id
    route.replaceConversation(next.draft ? null : next.id)
    await activateConversation(next.id)
  }

  function handleNew() {
    if (!user) return
    layout.setDrawerOpen(false)
    layout.setOpenArtifactId(null)
    const existingDraftId = draftIdRef.current
    const existingDraft = existingDraftId
      ? conversationsRef.current.find(conversation => conversation.id === existingDraftId)
      : undefined
    // Reuse only a genuinely empty draft. A failed or delayed first send must
    // never trap the New Chat action on the same conversation.
    if (existingDraft && existingDraft.messages.length === 0) {
      rootConversationIdRef.current = existingDraft.id
      route.openConversation(null)
      setActiveId(existingDraft.id)
      activationTokenRef.current += 1
      setHydratingConversationId(null)
      return
    }
    const id = crypto.randomUUID()
    draftIdRef.current = id
    rootConversationIdRef.current = id
    setConversations(previous => [createDraft(id), ...previous])
    route.openConversation(null)
    setActiveId(id)
    activationTokenRef.current += 1
    setHydratingConversationId(null)
  }

  function handleNewInProject(projectId: string) {
    const id = project.handleNewInProject(projectId)
    if (!id) return
    rootConversationIdRef.current = id
    layout.setOpenArtifactId(null)
    route.openConversation(null)
  }

  function handleToggleStar(id: string) {
    const current = conversationsRef.current.find(conversation => conversation.id === id)
    if (!current) return
    const starred = !current.starred
    setConversations(previous => previous.map(conversation => conversation.id === id ? { ...conversation, starred } : conversation))
    setConversationStarred(id, starred)
  }

  function handleTogglePin(id: string) {
    const current = conversationsRef.current.find(conversation => conversation.id === id)
    if (!current) return
    const pinned = !current.pinned
    setConversations(previous => previous.map(conversation => conversation.id === id ? { ...conversation, pinned } : conversation))
    setConversationPinned(id, pinned)
  }

  function handleRename(id: string, title: string) {
    const nextTitle = title.trim()
    if (!nextTitle) return
    setConversations(previous => previous.map(conversation => conversation.id === id ? { ...conversation, title: nextTitle } : conversation))
    updateConversationTitle(id, nextTitle)
  }

  function handleMove(id: string, projectId: string | null) {
    setConversations(previous => previous.map(conversation => conversation.id === id ? { ...conversation, projectId } : conversation))
    setConversationProject(id, projectId)
  }

  async function handleLogout() {
    await createClient().auth.signOut()
    setUser(null)
  }

  const sidebar: AppSidebarProps = {
    conversation: {
      items: conversations, activeId, select: handleSelect, create: handleNew, delete: handleDelete,
      toggleStar: handleToggleStar, togglePin: handleTogglePin, rename: handleRename, move: handleMove,
    },
    memory: {
      items: memory.memories, enabled: memory.memoryEnabled, setEnabled: memory.handleMemoryEnabledChange,
      add: memory.handleMemoryAdd, edit: memory.handleMemoryEdit, delete: memory.handleMemoryDelete,
    },
    project: {
      items: project.projects, create: project.handleProjectCreate, rename: project.handleProjectRename,
      setInstructions: project.handleProjectInstructions, delete: project.handleProjectDelete,
      createConversation: handleNewInProject, loadFiles: project.handleLoadProjectFiles,
      addFile: project.handleAddProjectFile, deleteFile: project.handleDeleteProjectFile,
      loadMemories: project.handleLoadProjectMemories, addMemory: project.handleAddProjectMemory,
      editMemory: project.handleEditProjectMemory, deleteMemory: project.handleDeleteProjectMemory,
    },
    model: {
      endpoints: model.modelEndpoints, activeId: model.activeEndpointId, select: model.handleEndpointSelect,
      created: model.handleEndpointCreated, updated: model.handleEndpointUpdated, deleted: model.handleEndpointDeleted,
    },
    session: {
      email: user?.email ?? "", logout: handleLogout,
      openCode: () => { layout.setDrawerOpen(false); layout.setCodeOpen(true) },
      openArtifacts: () => { layout.setDrawerOpen(false); layout.setArtifactLibraryOpen(true) },
    },
  }

  if (!authChecked) return <div className="h-dvh w-full bg-background paper-grain" />
  if (!user) return <LoginScreen />

  const controller: LiteraryChatViewController = {
    session: { user },
    conversation: {
      active, activeProject, projects: project.projects,
      actions: { rename: handleRename, delete: handleDelete, toggleStar: handleToggleStar, togglePin: handleTogglePin, move: handleMove },
    },
    sidebar,
    layout,
    chat: {
      scrollRef,
      messages: {
        onRegenerate: generation.handleRegenerate,
        onEditUserMessage: generation.handleEditUserMessage,
        onRegenerateFromUser: generation.handleRegenerateFromUser,
        isLoading: !authorityReady || generation.isActiveGenerating,
        onOpenArtifact: layout.setOpenArtifactId,
        openArtifactId: layout.openArtifactId,
      },
      input: {
        onSend: generation.handleSend,
        activeTier: model.activeTier,
        onTierChange: model.handleTierChange,
        customEndpoints: model.modelEndpoints,
        activeEndpointId: model.activeEndpointId,
        onEndpointChange: model.handleEndpointSelect,
        searchMode,
        onSearchModeChange: setSearchMode,
        deepResearch,
        onDeepResearchChange: setDeepResearch,
        historyRetrieval,
        onHistoryRetrievalChange: setHistoryRetrieval,
        disabled: !authorityReady,
        isLoading: generation.isActiveGenerating,
        onStop: generation.handleStop,
      },
    },
  }

  return <LiteraryChatView controller={controller} />
}
