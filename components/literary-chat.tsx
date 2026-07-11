"use client"

import { useMemo, useRef, useState, useEffect } from "react"
import { type Conversation, type Message, type Tier, TIERS, TIER_MAP } from "@/lib/chat-data"
import { type Memory } from "@/lib/memory-data"
import {
  fetchMemories, insertMemory, updateMemory, deleteMemoryRow,
  fetchConversations, insertConversation, updateConversationTitle, touchConversation, deleteConversationRow,
  setConversationStarred, setConversationPinned, setConversationProject,
  fetchMessages, insertMessage, updateMessageContent, lastExcerpt, conversationExcerpt,
  deleteMessageRow,
  fetchProfile, ensureProfile, setMemoryEnabled,
  fetchProjects, insertProject, updateProject, deleteProjectRow,
  fetchProjectFiles, insertProjectFile, deleteProjectFileRow, fetchProjectContext,
  fetchProjectMemories, insertProjectMemory, updateProjectMemory, deleteProjectMemoryRow,
} from "@/lib/data"
import { type AttachedFile, prepareFile } from "@/lib/file-extract"
import type { Project, ProjectFile, ProjectContext } from "@/lib/project-data"
import { AppSidebar } from "@/components/app-sidebar"
import { CodeConsole } from "@/components/code-console"
import { MessageList } from "@/components/message-list"
import { ChatInput } from "@/components/chat-input"
import { LoginScreen } from "@/components/login-screen"
import { createClient } from "@/lib/supabase/client"
import type { User } from "@supabase/supabase-js"
import { cn } from "@/lib/utils"
import { PanelLeft, Folder, ChevronDown } from "lucide-react"
import { parseArtifact, artifactTitle } from "@/lib/artifact"
import { ArtifactPanel } from "@/components/artifact-panel"
import { ConversationMenu, ConversationRename } from "@/components/conversation-menu"
import type { SearchMode } from "@/lib/search-mode"

type HistoryMsg = { id?: string; role: string; content: string; images?: string[]; imageSummary?: string; ts?: string }

function toHistoryMsg(m: Message): HistoryMsg {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    ...(m.images?.length ? { images: m.images } : {}),
    ...(m.imageSummary ? { imageSummary: m.imageSummary } : {}),
    ...(m.ts ? { ts: m.ts } : {}),
  }
}

export function LiteraryChat() {
  const [user, setUser] = useState<User | null>(null)
  const [authChecked, setAuthChecked] = useState(false)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState("")
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [codeOpen, setCodeOpen] = useState(false)
  const [memories, setMemories] = useState<Memory[]>([])
  const [memoryEnabled, setMemoryEnabledState] = useState(true)
  const [searchMode, setSearchMode] = useState<SearchMode>("off")
  const [deepResearch, setDeepResearch] = useState(false)
  const [historyRetrieval, setHistoryRetrieval] = useState(false)
  const [activeTier, setActiveTier] = useState<Tier>("绝句")
  const [openArtifactId, setOpenArtifactId] = useState<string | null>(null)
  const [headerMenuAnchor, setHeaderMenuAnchor] = useState<{ bottom: number; left: number } | null>(null)
  const [headerRenaming, setHeaderRenaming] = useState(false)
  const [projects, setProjects] = useState<Project[]>([])

  const abortRef = useRef<AbortController | null>(null)
  const loadedRef = useRef<Set<string>>(new Set())
  const projectCtxRef = useRef<Map<string, ProjectContext>>(new Map())
  const draftIdRef = useRef<string | null>(null)

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
      setMemories([])
      setMemoryEnabledState(true)
      setActiveId("")
      setProjects([])
      projectCtxRef.current.clear()
      draftIdRef.current = null
      loadedRef.current = new Set()
      return
    }
    let cancelled = false
    ;(async () => {
      ensureProfile(user.id)
      const [convs, mems, prof, projs] = await Promise.all([fetchConversations(), fetchMemories(), fetchProfile(), fetchProjects()])
      if (cancelled) return
      setMemories(mems)
      setMemoryEnabledState(prof.memoryEnabled)
      setProjects(projs)
      try {
        const saved = localStorage.getItem("chat_active_tier") as Tier | null
        if (saved && TIERS.some(t => t.id === saved)) setActiveTier(saved)
      } catch {}
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

  function handleTierChange(t: Tier) {
    setActiveTier(t)
    try { localStorage.setItem("chat_active_tier", t) } catch {}
  }

  const activeName = TIER_MAP[activeTier]?.label ?? activeTier

  const active = useMemo(
    () => conversations.find(c => c.id === activeId),
    [conversations, activeId],
  )

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
    if (loadedRef.current.has(id)) return
    loadedRef.current.add(id)
    const msgs = await fetchMessages(id)
    setConversations(prev => prev.map(c => c.id === id ? { ...c, messages: msgs, excerpt: lastExcerpt(msgs) } : c))
  }

  async function generateTitle(convId: string, userText: string, aiText: string) {
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tier: "绝句",
          messages: [{ role: "user", content: `根据下面这段对话，给出一个10字以内的标题，只输出标题本身，不要引号和标点：\n用户：${userText.slice(0, 80)}\nAI：${aiText.slice(0, 80)}` }],
        }),
      })
      if (!res.body) return
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let title = "", buf = ""
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const parts = buf.split("\n\n"); buf = parts.pop() ?? ""
        for (const part of parts) {
          const line = part.trim()
          if (line.startsWith("data: ") && line !== "data: [DONE]") {
            try { const d = JSON.parse(line.slice(6)); if (d.text) title += d.text } catch {}
          }
        }
      }
      const clean = title.trim().replace(/^["'「『]|["'」』]$/g, "").slice(0, 20)
      if (clean) {
        setConversations(prev => prev.map(c => c.id === convId ? { ...c, title: clean } : c))
        updateConversationTitle(convId, clean)
      }
    } catch {}
  }

  async function runAiStream(
    messages: HistoryMsg[],
    msgId: string,
    convId: string,
    controller: AbortController,
    attachments?: AttachedFile[],
    projectCtx?: ProjectContext,
  ): Promise<string> {
    if (!user) { setIsLoading(false); return "" }

    const history = messages
    let fullReply = "", hadError = false
    let renderScheduled = false
    let rafId: number | null = null

    const flushStreamMessage = () => {
      renderScheduled = false
      rafId = null
      setConversations(prev => prev.map(c => c.id !== convId ? c : {
        ...c,
        messages: c.messages.map(m => m.id !== msgId ? m : {
          ...m,
          content: fullReply,
        }),
      }))
    }

    const scheduleStreamMessage = () => {
      if (hadError || renderScheduled) return
      renderScheduled = true
      rafId = requestAnimationFrame(flushStreamMessage)
    }

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tier: activeTier,
          messages: history,
          memories: projectCtx ? undefined : (memoryEnabled && memories.length > 0 ? memories : undefined),
          attachments: attachments && attachments.length > 0 ? attachments : undefined,
          searchMode,
          deepResearch,
          historyRetrieval,
          project: projectCtx,
          conversationId: convId,
        }),
      })

      if (!res.ok) {
        const error = await res.json().catch(() => null)
        throw new Error(error?.error ?? `请求失败（${res.status}）`)
      }
      if (!res.body) throw new Error("无响应体")

      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ""

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const parts = buf.split("\n\n"); buf = parts.pop() ?? ""

        for (const part of parts) {
          const line = part.trim()
          if (!line || line === "data: [DONE]") continue
          if (!line.startsWith("data: ")) continue
          try {
            const data = JSON.parse(line.slice(6))
            if (data.memory) {
              const mem = data.memory
              const note = mem.action === "create" ? (mem.ok ? `记住了：${mem.content}` : "记忆保存失败")
                : mem.action === "update" ? (mem.ok ? `更新了记忆：${mem.content}` : "记忆更新失败")
                : (mem.ok ? "忘记了一条记忆" : "记忆删除失败")
              setConversations(prev => prev.map(c => c.id !== convId ? c : {
                ...c,
                messages: c.messages.map(m => m.id !== msgId ? m : { ...m, memoryNotes: [...(m.memoryNotes ?? []), note] }),
              }))
              if (mem.ok && !projectCtx) {
                if (mem.action === "create" && mem.id) setMemories(prev => [...prev, { id: mem.id, content: mem.content ?? "", timestamp: mem.timestamp }])
                else if (mem.action === "update" && mem.id) setMemories(prev => prev.map(x => x.id === mem.id ? { ...x, content: mem.content ?? x.content, timestamp: mem.timestamp ?? x.timestamp } : x))
                else if (mem.action === "delete" && mem.id) setMemories(prev => prev.filter(x => x.id !== mem.id))
              }
              continue
            }
            if (data.search) {
              setConversations(prev => prev.map(c => c.id !== convId ? c : {
                ...c,
                messages: c.messages.map(m => m.id !== msgId ? m : { ...m, searchNotes: [...(m.searchNotes ?? []), data.search] }),
              }))
              continue
            }
            if (data.imageSummary) {
              const { messageId, summary } = data.imageSummary
              setConversations(prev => prev.map(c => c.id !== convId ? c : {
                ...c,
                messages: c.messages.map(m => m.id === messageId ? { ...m, imageSummary: summary } : m),
              }))
              continue
            }
            if (data.error) {
              hadError = true
              setConversations(prev => prev.map(c => c.id !== convId ? c : {
                ...c,
                messages: c.messages.map(m => m.id !== msgId ? m : { ...m, content: data.error, isError: true }),
              }))
              continue
            }
            if (data.text) {
              fullReply += data.text
              scheduleStreamMessage()
            }
          } catch {}
        }
      }

      if (!hadError) {
        if (rafId !== null) cancelAnimationFrame(rafId)
        flushStreamMessage()
      }

      if (!hadError && fullReply) {
        insertMessage(user.id, convId, { id: msgId, role: "assistant", content: fullReply, time: "" })
        touchConversation(convId)
        setConversations(prev => prev.map(c => c.id === convId ? { ...c, excerpt: conversationExcerpt(fullReply), date: "今日" } : c))
      }
    } catch (e: any) {
      if (e?.name === "AbortError") return fullReply
      setConversations(prev => prev.map(c => c.id !== convId ? c : {
        ...c,
        messages: c.messages.map((m, i, arr) =>
          i === arr.length - 1 && m.role === "assistant"
            ? { ...m, content: e?.message ?? String(e), isError: true }
            : m
        ),
      }))
    } finally {
      if (rafId !== null) cancelAnimationFrame(rafId)
      setIsLoading(false)
    }
    return fullReply
  }

  function handleStop() {
    abortRef.current?.abort()
  }

  async function handleSend(text: string, images?: string[], files?: AttachedFile[]) {
    if (!user || !active) return

    const userMsg: Message = { id: crypto.randomUUID(), role: "user", content: text, time: "此刻", ts: new Date().toISOString(), images: images?.length ? images : undefined, files: files?.map(f => f.name) }
    const msgId = crypto.randomUUID()
    const assistantMsg: Message = { id: msgId, role: "assistant", content: "", time: "此刻" }
    const isFirstExchange = active.messages.length === 0
    const wasDraft = !!active.draft
    const draftId = active.id
    const baseHistory = active.messages

    setConversations(prev => prev.map(c => c.id === draftId
      ? { ...c, draft: false, messages: [...c.messages, userMsg, assistantMsg] }
      : c))
    setIsLoading(true)

    let convId = draftId
    try {
      if (wasDraft) {
        const realId = await insertConversation(user.id, "未命名的篇章", active.projectId ?? undefined)
        if (!realId) {
          setConversations(prev => prev.map(c => c.id === draftId
            ? { ...c, draft: true, messages: c.messages.map(m => m.id === msgId ? { ...m, content: "创建会话失败，请重试", isError: true } : m) }
            : c))
          setIsLoading(false)
          return
        }
        convId = realId
        loadedRef.current.add(realId)
        draftIdRef.current = null
        setConversations(prev => prev.map(c => c.id === draftId ? { ...c, id: realId } : c))
        setActiveId(realId)
        await insertMessage(user.id, realId, userMsg)
      } else {
        await insertMessage(user.id, convId, userMsg)
      }

      const history = [...baseHistory, userMsg].map(toHistoryMsg)
      const projectCtx = await getProjectContext(active.projectId)
      const controller = new AbortController()
      abortRef.current = controller
      const fullReply = await runAiStream(history, msgId, convId, controller, files?.length ? files : undefined, projectCtx)

      if (isFirstExchange && fullReply) generateTitle(convId, text, fullReply)
    } catch (e) {
      console.error("handleSend failed", e)
      setIsLoading(false)
      setConversations(prev => prev.map(c => c.id === convId
        ? { ...c, messages: c.messages.map(m => m.id === msgId ? { ...m, content: m.content || "发送失败，请重试", isError: true } : m) }
        : c))
    }
  }

  async function handleRegenerate() {
    if (!user || !active || isLoading) return
    setOpenArtifactId(null)
    const msgs = active.messages
    const lastAiIdx = [...msgs].map((m, i) => ({ m, i })).reverse().find(({ m }) => m.role === "assistant")?.i ?? -1
    if (lastAiIdx === -1) return
    const lastAiMsg = msgs[lastAiIdx]

    const historyBeforeAi = msgs.slice(0, lastAiIdx).map(toHistoryMsg)
    const newMsgId = crypto.randomUUID()
    setConversations(prev => prev.map(c => c.id !== activeId ? c : {
      ...c,
      messages: [
        ...msgs.slice(0, lastAiIdx),
        { id: newMsgId, role: "assistant" as const, content: "", time: "此刻" },
      ],
    }))
    deleteMessageRow(lastAiMsg.id)

    setIsLoading(true)
    try {
      const projectCtx = await getProjectContext(active.projectId)
      const controller = new AbortController()
      abortRef.current = controller
      await runAiStream(historyBeforeAi, newMsgId, activeId, controller, undefined, projectCtx)
    } catch (e) {
      console.error("handleRegenerate failed", e)
      setIsLoading(false)
    }
  }

  async function regenerateFromUserMessage(userMessageId: string, editedContent?: string) {
    if (!user || !active || isLoading) return
    setOpenArtifactId(null)
    const convId = active.id
    const msgs = active.messages
    const userIdx = msgs.findIndex(m => m.id === userMessageId && m.role === "user")
    if (userIdx === -1) return

    const sourceUser = msgs[userIdx]
    const nextContent = (editedContent ?? sourceUser.content).trim()
    if (!nextContent) return
    const nextUser: Message = { ...sourceUser, content: nextContent, ts: sourceUser.ts ?? new Date().toISOString() }
    const removed = msgs.slice(userIdx + 1)
    const newMsgId = crypto.randomUUID()
    const assistantMsg: Message = { id: newMsgId, role: "assistant", content: "", time: "此刻" }

    setConversations(prev => prev.map(c => c.id !== convId ? c : {
      ...c,
      messages: [...msgs.slice(0, userIdx), nextUser, assistantMsg],
    }))

    if (nextContent !== sourceUser.content.trim()) updateMessageContent(convId, sourceUser.id, nextContent)
    removed.forEach(m => deleteMessageRow(m.id))

    setIsLoading(true)
    try {
      const history = [...msgs.slice(0, userIdx), nextUser].map(toHistoryMsg)
      const projectCtx = await getProjectContext(active.projectId)
      const controller = new AbortController()
      abortRef.current = controller
      await runAiStream(history, newMsgId, convId, controller, undefined, projectCtx)
    } catch (e) {
      console.error("regenerateFromUserMessage failed", e)
      setIsLoading(false)
      setConversations(prev => prev.map(c => c.id !== convId ? c : {
        ...c,
        messages: c.messages.map(m => m.id === newMsgId ? { ...m, content: "重新回复失败，请重试", isError: true } : m),
      }))
    }
  }

  function handleEditUserMessage(messageId: string, content: string) {
    regenerateFromUserMessage(messageId, content)
  }

  function handleRegenerateFromUser(messageId: string) {
    regenerateFromUserMessage(messageId)
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

  async function getProjectContext(projectId?: string | null): Promise<ProjectContext | undefined> {
    if (!projectId) return undefined
    const cached = projectCtxRef.current.get(projectId)
    if (cached) return cached
    const ctx = await fetchProjectContext(projectId)
    projectCtxRef.current.set(projectId, ctx)
    return ctx
  }

  async function handleProjectCreate(name: string): Promise<Project | null> {
    if (!user) return null
    const p = await insertProject(user.id, name)
    if (p) setProjects(prev => [p, ...prev])
    return p
  }
  function handleProjectRename(id: string, name: string) {
    setProjects(prev => prev.map(p => p.id === id ? { ...p, name } : p))
    updateProject(id, { name })
  }
  function handleProjectInstructions(id: string, instructions: string) {
    setProjects(prev => prev.map(p => p.id === id ? { ...p, instructions } : p))
    updateProject(id, { instructions })
    projectCtxRef.current.delete(id)
  }
  function handleProjectDelete(id: string) {
    setProjects(prev => prev.filter(p => p.id !== id))
    projectCtxRef.current.delete(id)
    setConversations(prev => prev.map(c => c.projectId === id ? { ...c, projectId: null } : c))
    deleteProjectRow(id)
  }
  function handleNewInProject(projectId: string) {
    if (!user) return
    setDrawerOpen(false)
    if (draftIdRef.current) {
      const did = draftIdRef.current
      setConversations(prev => prev.map(c => c.id === did ? { ...c, projectId } : c))
      setActiveId(did)
      return
    }
    const id = crypto.randomUUID()
    draftIdRef.current = id
    setConversations(prev => [{ id, title: "未命名的篇章", excerpt: "", date: "今日", messages: [], draft: true, projectId }, ...prev])
    setActiveId(id)
  }
  async function handleLoadProjectFiles(projectId: string): Promise<ProjectFile[]> {
    return fetchProjectFiles(projectId)
  }
  async function handleAddProjectFile(projectId: string, file: File): Promise<ProjectFile | null> {
    if (!user) return null
    try {
      const prepared = await prepareFile(file)
      const content = prepared.text ?? ""
      const saved = await insertProjectFile(user.id, projectId, prepared.name, content)
      if (saved) projectCtxRef.current.delete(projectId)
      return saved
    } catch {
      return null
    }
  }
  function handleDeleteProjectFile(fileId: string) {
    deleteProjectFileRow(fileId)
    projectCtxRef.current.clear()
  }

  async function handleLoadProjectMemories(projectId: string): Promise<Memory[]> {
    return fetchProjectMemories(projectId)
  }
  async function handleAddProjectMemory(projectId: string, content: string): Promise<Memory | null> {
    if (!user) return null
    const mem = await insertProjectMemory(user.id, projectId, content)
    if (mem) projectCtxRef.current.delete(projectId)
    return mem
  }
  function handleEditProjectMemory(id: string, content: string) {
    updateProjectMemory(id, content)
    projectCtxRef.current.clear()
  }
  function handleDeleteProjectMemory(id: string) {
    deleteProjectMemoryRow(id)
    projectCtxRef.current.clear()
  }

  async function handleMemoryAdd(content: string) {
    if (!user) return
    const mem = await insertMemory(user.id, content)
    if (mem) setMemories(prev => [...prev, mem])
  }
  async function handleMemoryEdit(id: string, content: string) {
    const ts = new Date().toISOString()
    setMemories(prev => prev.map(m => m.id === id ? { ...m, content, timestamp: ts } : m))
    updateMemory(id, content)
  }
  async function handleMemoryDelete(id: string) {
    setMemories(prev => prev.filter(m => m.id !== id))
    deleteMemoryRow(id)
  }

  function handleMemoryEnabledChange(v: boolean) {
    setMemoryEnabledState(v)
    if (user) setMemoryEnabled(user.id, v)
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
  }

  function renderChatPane(mobile: boolean) {
    return (
      <main className={cn("flex min-w-0 flex-1 flex-col overflow-hidden", !mobile && "ml-0")}>
        <header className={cn(
          "z-10 flex shrink-0 items-center gap-3 bg-background/90 backdrop-blur-sm",
          mobile ? "px-4 pb-2 pt-[max(0.75rem,env(safe-area-inset-top))]" : "px-8 py-4",
        )}>
          <button
            onClick={() => mobile ? setDrawerOpen(true) : setSidebarCollapsed(v => !v)}
            className="inline-flex shrink-0 rounded-full p-2 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            aria-label={mobile ? "打开对话列表" : "收起侧栏"}
          >
            <PanelLeft className="size-5" />
          </button>

          {headerRenaming && active ? (
            <ConversationRename
              value={active.title}
              onCommit={t => { if (t.trim()) handleRenameConversation(active.id, t.trim()); setHeaderRenaming(false) }}
              onCancel={() => setHeaderRenaming(false)}
              className="min-w-0 flex-1 rounded-lg bg-secondary/60 px-3 py-1.5 text-sm outline-none focus:bg-secondary/80"
            />
          ) : active ? (
            <button
              onClick={e => {
                if (active.draft) return
                if (headerMenuAnchor) { setHeaderMenuAnchor(null); return }
                const r = e.currentTarget.getBoundingClientRect()
                setHeaderMenuAnchor({ bottom: r.bottom, left: r.left })
              }}
              className={cn(
                "flex min-w-0 flex-1 items-center gap-1.5 rounded-full px-2 py-1 text-left transition-colors",
                !active.draft && "hover:bg-secondary/50",
              )}
            >
              {activeProject && (
                <>
                  <Folder className="size-3.5 shrink-0 text-primary/70" />
                  <span className="max-w-[6rem] shrink-0 truncate text-sm font-medium text-foreground/90">{activeProject.name.slice(0, 10)}</span>
                  <span className="shrink-0 text-muted-foreground/40">/</span>
                </>
              )}
              <span className="min-w-0 truncate text-sm italic text-muted-foreground">{active.title}</span>
              {!active.draft && <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground/60 transition-transform", headerMenuAnchor && "rotate-180")} />}
            </button>
          ) : (
            <span className="flex-1" />
          )}
        </header>

        <div
          ref={mobile ? mobileScrollRef : desktopScrollRef}
          className="min-h-0 min-w-0 flex-1 overflow-x-clip overflow-y-auto overscroll-contain bg-background font-serif"
        >
          {active && active.messages.length > 0 ? (
            <MessageList
              conversation={active}
              onRegenerate={handleRegenerate}
              onEditUserMessage={handleEditUserMessage}
              onRegenerateFromUser={handleRegenerateFromUser}
              isLoading={isLoading}
              onOpenArtifact={setOpenArtifactId}
              openArtifactId={openArtifactId}
            />
          ) : (
            <EmptyState endpointName={activeName} />
          )}
        </div>

        <ChatInput
          onSend={handleSend}
          activeTier={activeTier}
          onTierChange={handleTierChange}
          mobile={mobile}
          searchMode={searchMode}
          onSearchModeChange={setSearchMode}
          deepResearch={deepResearch}
          onDeepResearchChange={setDeepResearch}
          historyRetrieval={historyRetrieval}
          onHistoryRetrievalChange={setHistoryRetrieval}
          isLoading={isLoading}
          onStop={handleStop}
        />
      </main>
    )
  }

  if (!authChecked) return <div className="h-dvh w-full bg-background paper-grain" />
  if (!user) return <LoginScreen />

  const openMsg = openArtifactId ? active?.messages.find(m => m.id === openArtifactId) : null
  const openArt = openMsg ? parseArtifact(openMsg.content) : null
  const showArt = !!(openArt && openArt.raw !== null)

  return (
    <>
      {codeOpen && <CodeConsole userId={user.id} onExit={() => setCodeOpen(false)} />}
      <div className="hidden h-dvh min-h-0 w-full overflow-hidden bg-background py-4 pr-4 pl-0 paper-grain md:flex">
        <div className={cn("shrink-0 overflow-hidden transition-[width] duration-300 ease-in-out", sidebarCollapsed ? "w-0" : "w-[20rem]")}>
          <div className="h-full w-[20rem] overflow-hidden border-r border-border/50 bg-sidebar/40">
            <AppSidebar {...sidebarProps} />
          </div>
        </div>
        {renderChatPane(false)}
        {showArt && (
          <aside className="ml-2 hidden w-[44%] min-w-[360px] max-w-[720px] shrink-0 overflow-hidden rounded-2xl border border-border/50 md:block">
            <ArtifactPanel
              key={openArtifactId}
              raw={openArt!.raw!}
              done={openArt!.done}
              title={artifactTitle(openArt!.raw!)}
              onClose={() => setOpenArtifactId(null)}
            />
          </aside>
        )}
      </div>

      <div className="flex h-dvh min-h-0 w-full overflow-hidden bg-background paper-grain md:hidden">
        <div className={cn("fixed inset-0 z-40", drawerOpen ? "pointer-events-auto" : "pointer-events-none")}>
          <button
            type="button"
            aria-label="收起侧栏"
            onClick={() => setDrawerOpen(false)}
            className={cn("absolute inset-0 bg-black/50 transition-opacity duration-300", drawerOpen ? "opacity-100" : "opacity-0")}
          />
          <AppSidebar {...sidebarProps} mobile visible={drawerOpen} onClose={() => setDrawerOpen(false)} />
        </div>
        {renderChatPane(true)}
        {showArt && (
          <div className="fixed inset-0 z-50 bg-background">
            <ArtifactPanel
              key={openArtifactId}
              raw={openArt!.raw!}
              done={openArt!.done}
              title={artifactTitle(openArt!.raw!)}
              onClose={() => setOpenArtifactId(null)}
            />
          </div>
        )}
      </div>

      {active && !active.draft && headerMenuAnchor && (
        <ConversationMenu
          conversation={active}
          anchor={headerMenuAnchor}
          projects={projects}
          onClose={() => setHeaderMenuAnchor(null)}
          onToggleStar={() => { handleToggleStar(active.id); setHeaderMenuAnchor(null) }}
          onTogglePin={() => { handleTogglePin(active.id); setHeaderMenuAnchor(null) }}
          onRename={() => { setHeaderMenuAnchor(null); setHeaderRenaming(true) }}
          onMove={pid => { handleAddToProject(active.id, pid); setHeaderMenuAnchor(null) }}
          onDelete={() => { handleDelete(active.id); setHeaderMenuAnchor(null) }}
        />
      )}
    </>
  )
}

function EmptyState({ endpointName }: { endpointName?: string }) {
  return (
    <div className="mx-auto flex h-full max-w-[40rem] flex-col items-center justify-center px-8 text-center">
      <p className="text-[15px] italic text-muted-foreground/60">
        {endpointName && endpointName !== "笔友" ? `与 ${endpointName} 对谈` : "说点什么开始对谈"}
      </p>
    </div>
  )
}
