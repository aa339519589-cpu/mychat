"use client"

import { useMemo, useRef, useState, useEffect } from "react"
import { type Conversation } from "@/lib/chat-data"
import {
  fetchMemories, fetchProfile, ensureProfile,
  fetchConversations, updateConversationTitle, deleteConversationRow,
  setConversationStarred, setConversationPinned, setConversationProject,
  fetchMessages, lastExcerpt,
  fetchProjects, fetchModelEndpoints,
} from "@/lib/data"
import { LoginScreen } from "@/components/login-screen"
import { createClient } from "@/lib/supabase/client"
import type { User } from "@supabase/supabase-js"
import type { SearchMode } from "@/lib/search-mode"
import { useChatGeneration } from "@/components/literary-chat/use-chat-generation"
import { useProjects } from "@/components/literary-chat/use-projects"
import { useModelSelection } from "@/components/literary-chat/use-model-selection"
import { useMemories } from "@/components/literary-chat/use-memories"
import { useLiteraryChatLayoutState } from "@/components/literary-chat/layout-state"
import { LiteraryChatView } from "@/components/literary-chat/literary-chat-view"

export function LiteraryChat() {
  const [user, setUser] = useState<User | null>(null)
  const [authChecked, setAuthChecked] = useState(false)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState("")
  const [searchMode, setSearchMode] = useState<SearchMode>("off")
  const [deepResearch, setDeepResearch] = useState(false)
  const [historyRetrieval, setHistoryRetrieval] = useState(false)
  const layout = useLiteraryChatLayoutState()
  const { setCodeOpen, setDrawerOpen, setOpenArtifactId } = layout
  const loadedRef = useRef<Set<string>>(new Set())
  const draftIdRef = useRef<string | null>(null)
  const {
    memories,
    memoryEnabled,
    setMemories,
    restoreMemories,
    resetMemories,
    handleMemoryAdd,
    handleMemoryEdit,
    handleMemoryDelete,
    handleMemoryEnabledChange,
  } = useMemories(user)
  const {
    activeTier,
    modelEndpoints,
    activeEndpointId,
    activeEndpoint,
    restoreModelSelection,
    resetModelEndpoints,
    handleTierChange,
    handleEndpointSelect,
    handleEndpointCreated,
    handleEndpointUpdated,
    handleEndpointDeleted,
  } = useModelSelection({ setSearchMode, setDeepResearch, setHistoryRetrieval })
  const {
    projects,
    setProjects,
    resetProjects,
    getProjectContext,
    handleProjectCreate,
    handleProjectRename,
    handleProjectInstructions,
    handleProjectDelete,
    handleNewInProject,
    handleLoadProjectFiles,
    handleAddProjectFile,
    handleDeleteProjectFile,
    handleLoadProjectMemories,
    handleAddProjectMemory,
    handleEditProjectMemory,
    handleDeleteProjectMemory,
  } = useProjects({ user, draftIdRef, setActiveId, setConversations, setDrawerOpen })

  useEffect(() => {
    if (typeof window !== "undefined" && window.location.search.includes("github=")) {
      if (window.location.search.includes("github=connected")) setCodeOpen(true)
      window.history.replaceState({}, "", window.location.pathname)
    }
  }, [])


  useEffect(() => {
    const supabase = createClient()
    supabase.auth.getUser().then(({ data }) => {
      setUser(data.user)
      setAuthChecked(true)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
      setAuthChecked(true)
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!user) {
      setConversations([])
      resetMemories()
      setActiveId("")
      resetProjects()
      resetModelEndpoints()
      draftIdRef.current = null
      loadedRef.current = new Set()
      return
    }
    let cancelled = false
    ;(async () => {
      ensureProfile(user.id)
      const [convs, mems, prof, projs, endpoints] = await Promise.all([
        fetchConversations(), fetchMemories(), fetchProfile(), fetchProjects(), fetchModelEndpoints().catch(() => []),
      ])
      if (cancelled) return
      restoreMemories(mems, prof.memoryEnabled)
      setProjects(projs)
      restoreModelSelection(endpoints)
      for (const c of convs) if (c.msgCount === 0) deleteConversationRow(c.id)
      const real = convs.filter(c => c.msgCount !== 0)
      if (real.length === 0) {
        const id = crypto.randomUUID()
        draftIdRef.current = id
        setConversations([{ id, title: "未命名的篇章", excerpt: "", date: "今日", messages: [], draft: true }])
        setActiveId(id)
      } else {
        setConversations(real)
        setActiveId(real[0].id)
        const msgs = await fetchMessages(real[0].id)
        if (cancelled) return
        loadedRef.current.add(real[0].id)
        setConversations(prev => prev.map(c => c.id === real[0].id ? { ...c, messages: msgs, excerpt: lastExcerpt(msgs) } : c))
      }
    })()
    return () => { cancelled = true }
  }, [user])

  const active = useMemo(
    () => conversations.find(c => c.id === activeId),
    [conversations, activeId],
  )

  const {
    isActiveGenerating,
    handleStop,
    handleSend,
    handleRegenerate,
    handleEditUserMessage,
    handleRegenerateFromUser,
    resumeGenerationIfNeeded,
  } = useChatGeneration({
    user,
    active,
    activeId,
    activeTier,
    activeEndpoint,
    activeEndpointId,
    memories,
    memoryEnabled,
    searchMode,
    deepResearch,
    historyRetrieval,
    setActiveId,
    setConversations,
    setMemories,
    setOpenArtifactId,
    loadedRef,
    draftIdRef,
    getProjectContext,
  })

  const activeProject = useMemo(
    () => projects.find(p => p.id === active?.projectId) ?? null,
    [projects, active?.projectId],
  )

  const desktopScrollRef = useRef<HTMLDivElement>(null)
  const mobileScrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    for (const el of [desktopScrollRef.current, mobileScrollRef.current]) {
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
    }
  }, [active?.messages?.length, activeId])

  async function handleSelect(id: string) {
    setActiveId(id)
    setDrawerOpen(false)
    setOpenArtifactId(null)
    void resumeGenerationIfNeeded(id)
    if (loadedRef.current.has(id)) return
    loadedRef.current.add(id)
    const msgs = await fetchMessages(id)
    setConversations(prev => prev.map(c => c.id === id ? { ...c, messages: msgs, excerpt: lastExcerpt(msgs) } : c))
  }

  async function handleDelete(id: string) {
    deleteConversationRow(id)
    loadedRef.current.delete(id)
    if (draftIdRef.current === id) draftIdRef.current = null
    const remaining = conversations.filter(c => c.id !== id)
    if (remaining.length === 0) {
      const draftId = crypto.randomUUID()
      draftIdRef.current = draftId
      setConversations([{ id: draftId, title: "未命名的篇章", excerpt: "", date: "今日", messages: [], draft: true }])
      setActiveId(draftId)
      return
    }
    setConversations(remaining)
    if (activeId === id) {
      const next = remaining.find(c => !c.draft) ?? remaining[0]
      setActiveId(next.id)
      if (!next.draft && !loadedRef.current.has(next.id)) {
        loadedRef.current.add(next.id)
        const msgs = await fetchMessages(next.id)
        setConversations(prev => prev.map(c => c.id === next.id ? { ...c, messages: msgs, excerpt: lastExcerpt(msgs) } : c))
      }
    }
  }

  function handleNew() {
    if (!user) return
    setDrawerOpen(false)
    if (draftIdRef.current) { setActiveId(draftIdRef.current); return }
    const id = crypto.randomUUID()
    draftIdRef.current = id
    setConversations(prev => [{ id, title: "未命名的篇章", excerpt: "", date: "今日", messages: [], draft: true }, ...prev])
    setActiveId(id)
  }

  function handleToggleStar(id: string) {
    const cur = conversations.find(c => c.id === id)
    if (!cur) return
    const next = !cur.starred
    setConversations(prev => prev.map(c => c.id === id ? { ...c, starred: next } : c))
    setConversationStarred(id, next)
  }
  function handleTogglePin(id: string) {
    const cur = conversations.find(c => c.id === id)
    if (!cur) return
    const next = !cur.pinned
    setConversations(prev => prev.map(c => c.id === id ? { ...c, pinned: next } : c))
    setConversationPinned(id, next)
  }
  function handleRenameConversation(id: string, title: string) {
    const t = title.trim()
    if (!t) return
    setConversations(prev => prev.map(c => c.id === id ? { ...c, title: t } : c))
    updateConversationTitle(id, t)
  }
  function handleAddToProject(id: string, projectId: string | null) {
    setConversations(prev => prev.map(c => c.id === id ? { ...c, projectId } : c))
    setConversationProject(id, projectId)
  }

  async function handleLogout() {
    const supabase = createClient()
    await supabase.auth.signOut()
    setUser(null)
  }

  const sidebarProps = {
    conversations, activeId,
    onSelect: handleSelect,
    onNew: handleNew,
    onDelete: handleDelete,
    memories,
    onMemoryAdd: handleMemoryAdd,
    onMemoryEdit: handleMemoryEdit,
    onMemoryDelete: handleMemoryDelete,
    memoryEnabled,
    onMemoryEnabledChange: handleMemoryEnabledChange,
    projects,
    onProjectCreate: handleProjectCreate,
    onProjectRename: handleProjectRename,
    onProjectInstructions: handleProjectInstructions,
    onProjectDelete: handleProjectDelete,
    onNewInProject: handleNewInProject,
    onLoadProjectFiles: handleLoadProjectFiles,
    onAddProjectFile: handleAddProjectFile,
    onDeleteProjectFile: handleDeleteProjectFile,
    onLoadProjectMemories: handleLoadProjectMemories,
    onAddProjectMemory: handleAddProjectMemory,
    onEditProjectMemory: handleEditProjectMemory,
    onDeleteProjectMemory: handleDeleteProjectMemory,
    onToggleStar: handleToggleStar,
    onTogglePin: handleTogglePin,
    onRenameConversation: handleRenameConversation,
    onAddToProject: handleAddToProject,
    userEmail: user?.email ?? "",
    onLogout: handleLogout,
    onOpenCode: () => { setDrawerOpen(false); setCodeOpen(true) },
    modelEndpoints,
    activeEndpointId,
    onEndpointSelect: handleEndpointSelect,
    onEndpointCreated: handleEndpointCreated,
    onEndpointUpdated: handleEndpointUpdated,
    onEndpointDeleted: handleEndpointDeleted,
  }

  if (!authChecked) return <div className="h-dvh w-full bg-background paper-grain" />
  if (!user) return <LoginScreen />

  return (
    <LiteraryChatView
      user={user}
      active={active}
      activeProject={activeProject}
      projects={projects}
      sidebarProps={sidebarProps}
      layout={layout}
      desktopScrollRef={desktopScrollRef}
      mobileScrollRef={mobileScrollRef}
      conversationActions={{
        rename: handleRenameConversation,
        delete: handleDelete,
        toggleStar: handleToggleStar,
        togglePin: handleTogglePin,
        move: handleAddToProject,
      }}
      messageProps={{
        onRegenerate: handleRegenerate,
        onEditUserMessage: handleEditUserMessage,
        onRegenerateFromUser: handleRegenerateFromUser,
        isLoading: isActiveGenerating,
        onOpenArtifact: setOpenArtifactId,
        openArtifactId: layout.openArtifactId,
      }}
      inputProps={{
        onSend: handleSend,
        activeTier,
        onTierChange: handleTierChange,
        customEndpoints: modelEndpoints,
        activeEndpointId,
        onEndpointChange: handleEndpointSelect,
        searchMode,
        onSearchModeChange: setSearchMode,
        deepResearch,
        onDeepResearchChange: setDeepResearch,
        historyRetrieval,
        onHistoryRetrievalChange: setHistoryRetrieval,
        isLoading: isActiveGenerating,
        onStop: handleStop,
      }}
    />
  )
}
