"use client"

import { useMemo, useRef, useState, useEffect } from "react"
import { type Conversation, type Message, type Tier, TIERS } from "@/lib/chat-data"
import { type Memory } from "@/lib/memory-data"
import {
  fetchMemories, insertMemory, updateMemory, deleteMemoryRow,
  fetchConversations, insertConversation, updateConversationTitle, touchConversation, deleteConversationRow,
  setConversationStarred, setConversationPinned, setConversationProject,
  fetchMessages, insertMessage, updateMessageContent, updateMessageFields, lastExcerpt, conversationExcerpt,
  cacheConversationMessages, deleteMessageRow, deleteMessageRows,
  fetchProfile, ensureProfile, setMemoryEnabled,
  fetchProjects, insertProject, updateProject, deleteProjectRow,
  fetchProjectFiles, insertProjectFile, deleteProjectFileRow, fetchProjectContext,
  fetchProjectMemories, insertProjectMemory, updateProjectMemory, deleteProjectMemoryRow,
  fetchModelEndpoints,
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
import type { ModelEndpointSummary } from "@/lib/model-endpoints"
import { MAX_GENERATED_MEDIA_ITEMS, normalizeGeneratedMedia, type GeneratedMedia } from "@/lib/generated-media"
import { planChatStreamFinalization } from "@/lib/chat-stream-finalization"
import { type ClientGenerationState, isRunning } from "@/lib/generation-client"
import { isImageGenerationIntent } from "@/lib/image-intent"

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
  const [generationByConv, setGenerationByConv] = useState<Record<string, ClientGenerationState>>({})
  const [codeOpen, setCodeOpen] = useState(false)
  const [memories, setMemories] = useState<Memory[]>([])
  const [memoryEnabled, setMemoryEnabledState] = useState(true)
  const [searchMode, setSearchMode] = useState<SearchMode>("off")
  const [deepResearch, setDeepResearch] = useState(false)
  const [historyRetrieval, setHistoryRetrieval] = useState(false)
  const [imageGenMode, setImageGenMode] = useState(false)
  // Platform image gen is available when deep-tier proxy is configured (same env as 深度).
  const platformImageAvailable = true
  const [activeTier, setActiveTier] = useState<Tier>("绝句")
  const [modelEndpoints, setModelEndpoints] = useState<ModelEndpointSummary[]>([])
  const [activeEndpointId, setActiveEndpointId] = useState<string | null>(null)
  const [openArtifactId, setOpenArtifactId] = useState<string | null>(null)
  const [headerMenuAnchor, setHeaderMenuAnchor] = useState<{ bottom: number; left: number } | null>(null)
  const [headerRenaming, setHeaderRenaming] = useState(false)
  const [projects, setProjects] = useState<Project[]>([])

  const abortByConvRef = useRef<Map<string, AbortController>>(new Map())
  const generationByConvRef = useRef(generationByConv)
  generationByConvRef.current = generationByConv
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
      setModelEndpoints([])
      setActiveEndpointId(null)
      projectCtxRef.current.clear()
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
      setMemories(mems)
      setMemoryEnabledState(prof.memoryEnabled)
      setProjects(projs)
      setModelEndpoints(endpoints)
      try {
        const selection = JSON.parse(localStorage.getItem("chat_model_selection") ?? "null") as { kind?: string; id?: string; tier?: Tier } | null
        if (selection?.kind === "custom" && endpoints.some(endpoint => endpoint.id === selection.id && !endpoint.needsReconnect)) {
          setActiveEndpointId(selection.id ?? null)
        } else {
          setActiveEndpointId(null)
        }
        const saved = localStorage.getItem("chat_active_tier") as Tier | null
        const selectedTier = selection?.kind === "builtin" ? selection.tier : saved
        if (selectedTier && TIERS.some(t => t.id === selectedTier)) setActiveTier(selectedTier)
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
    setActiveEndpointId(null)
    // keep imageGenMode — user may want 生图 with platform deep-tier proxy
    try {
      localStorage.setItem("chat_active_tier", t)
      localStorage.setItem("chat_model_selection", JSON.stringify({ kind: "builtin", tier: t }))
    } catch {}
  }

  function activateEndpoint(endpoint: ModelEndpointSummary) {
    setActiveEndpointId(endpoint.id)
    setImageGenMode(false)
    setSearchMode("off")
    if (endpoint.outputKind !== "chat") {
      setDeepResearch(false)
      setHistoryRetrieval(false)
    }
    try { localStorage.setItem("chat_model_selection", JSON.stringify({ kind: "custom", id: endpoint.id })) } catch {}
  }

  function handleEndpointSelect(id: string) {
    setImageGenMode(false)
    const endpoint = modelEndpoints.find(item => item.id === id && !item.needsReconnect)
    if (!endpoint) return
    activateEndpoint(endpoint)
  }

  function handleEndpointCreated(endpoint: ModelEndpointSummary) {
    setModelEndpoints(prev => [endpoint, ...prev.filter(item => item.id !== endpoint.id)])
    activateEndpoint(endpoint)
  }

  function handleEndpointUpdated(endpoint: ModelEndpointSummary) {
    setModelEndpoints(prev => prev.map(item => item.id === endpoint.id ? endpoint : item))
    activateEndpoint(endpoint)
  }

  function handleEndpointDeleted(id: string) {
    setModelEndpoints(prev => prev.filter(item => item.id !== id))
    if (activeEndpointId === id) handleTierChange(activeTier)
  }

  const activeEndpoint = useMemo(
    () => modelEndpoints.find(endpoint => endpoint.id === activeEndpointId && !endpoint.needsReconnect) ?? null,
    [modelEndpoints, activeEndpointId],
  )

  const active = useMemo(
    () => conversations.find(c => c.id === activeId),
    [conversations, activeId],
  )

  const activeGeneration = activeId ? generationByConv[activeId] : undefined
  const isActiveGenerating = isRunning(activeGeneration)

  function markGeneration(convId: string, patch: Partial<ClientGenerationState> & { status: ClientGenerationState["status"] }) {
    setGenerationByConv(prev => ({
      ...prev,
      [convId]: {
        conversationId: convId,
        status: patch.status,
        generationId: patch.generationId ?? prev[convId]?.generationId,
        assistantMessageId: patch.assistantMessageId ?? prev[convId]?.assistantMessageId,
      },
    }))
  }

  function clearAbort(convId: string, controller: AbortController) {
    if (abortByConvRef.current.get(convId) === controller) abortByConvRef.current.delete(convId)
  }

  async function resumeGenerationIfNeeded(conversationId: string) {
    try {
      const res = await fetch(`/api/generations/running?conversationId=${encodeURIComponent(conversationId)}`)
      if (!res.ok) return
      const data = await res.json()
      const gens = Array.isArray(data.generations) ? data.generations : []
      const running = gens.find((g: any) => g.status === 'running' || g.status === 'queued')
      if (!running) return
      markGeneration(conversationId, {
        status: 'running',
        generationId: running.id,
        assistantMessageId: running.assistantMessageId,
      })
      // apply latest content snapshot
      if (running.assistantMessageId && (running.content || running.thinking)) {
        setConversations(prev => prev.map(c => c.id !== conversationId ? c : {
          ...c,
          messages: c.messages.map(m => m.id === running.assistantMessageId ? {
            ...m,
            content: running.content || m.content,
            thinking: running.thinking || m.thinking,
          } : m),
        }))
      }
      // reconnect stream
      const controller = new AbortController()
      abortByConvRef.current.set(conversationId, controller)
      const after = running.sequence ?? 0
      console.info('[mychat/generation] task resumed', {
        conversationId,
        generationId: running.id,
        assistantMessageId: running.assistantMessageId,
        afterSequence: after,
      })
      const streamRes = await fetch(`/api/generations/${running.id}/stream?afterSequence=${after}`, { signal: controller.signal })
      if (!streamRes.ok || !streamRes.body) return
      const reader = streamRes.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      let full = running.content || ''
      let thinking = running.thinking || ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const parts = buf.split('\n\n'); buf = parts.pop() ?? ''
        for (const part of parts) {
          const line = part.trim()
          if (!line.startsWith('data: ')) continue
          try {
            const ev = JSON.parse(line.slice(6))
            if (typeof ev.content === 'string') full = ev.content
            if (typeof ev.thinking === 'string') thinking = ev.thinking
            if (typeof ev.delta === 'string' && ev.type === 'text') full += ev.delta
            if (typeof ev.delta === 'string' && ev.type === 'thinking') thinking += ev.delta
            setConversations(prev => prev.map(c => c.id !== conversationId ? c : {
              ...c,
              messages: c.messages.map(m => m.id === running.assistantMessageId ? {
                ...m,
                content: full,
                thinking: thinking || undefined,
              } : m),
            }))
            if (ev.type === 'done' || ['completed','failed','cancelled'].includes(ev.status)) {
              markGeneration(conversationId, {
                status: ev.status === 'completed' ? 'completed' : ev.status === 'cancelled' ? 'cancelled' : 'error',
                generationId: running.id,
                assistantMessageId: running.assistantMessageId,
              })
              clearAbort(conversationId, controller)
              return
            }
          } catch {}
        }
      }
      markGeneration(conversationId, { status: 'completed', generationId: running.id, assistantMessageId: running.assistantMessageId })
      clearAbort(conversationId, controller)
    } catch (e: any) {
      if (e?.name === 'AbortError') return
      console.warn('resumeGenerationIfNeeded', e)
    }
  }

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

  async function generateTitle(convId: string, userText: string, aiText: string) {
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(activeEndpoint ? { endpointId: activeEndpoint.id } : { tier: "绝句" }),
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
    generationId?: string,
  ): Promise<string> {
    if (!user) {
      markGeneration(convId, { status: 'error', generationId, assistantMessageId: msgId })
      return ""
    }
    markGeneration(convId, { status: 'running', generationId, assistantMessageId: msgId })

    const history = messages
    let fullReply = "", fullThinking = ""
    let terminalError: string | null = null
    let aborted = false
    const fullMedia: GeneratedMedia[] = []
    let renderScheduled = false
    let rafId: number | null = null

    const cancelScheduledRender = () => {
      if (rafId !== null) cancelAnimationFrame(rafId)
      renderScheduled = false
      rafId = null
    }

    const flushStreamMessage = (outputWarning?: string) => {
      renderScheduled = false
      rafId = null
      setConversations(prev => prev.map(c => c.id !== convId ? c : {
        ...c,
        messages: c.messages.map(m => m.id !== msgId ? m : {
          ...m,
          content: fullReply,
          thinking: fullThinking || undefined,
          media: fullMedia.length ? [...fullMedia] : undefined,
          isError: undefined,
          outputWarning,
        }),
      }))
    }

    const scheduleStreamMessage = () => {
      if (terminalError || aborted || renderScheduled) return
      renderScheduled = true
      rafId = requestAnimationFrame(() => flushStreamMessage())
    }

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tier: activeTier,
          ...(activeEndpoint ? { endpointId: activeEndpoint.id } : {}),
          messages: history,
          memories: projectCtx ? undefined : (memoryEnabled && memories.length > 0 ? memories : undefined),
          attachments: attachments && attachments.length > 0 ? attachments : undefined,
          searchMode,
          deepResearch,
          historyRetrieval,
          project: projectCtx,
          conversationId: convId,
          generationId,
          assistantMessageId: msgId,
          generateImage: !activeEndpointId && (imageGenMode || isImageGenerationIntent(String([...messages].reverse().find(m => m.role === "user")?.content ?? ""))),
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

      streamLoop: while (true) {
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
            if (data.generationId && data.assistantMessageId) {
              markGeneration(convId, {
                status: 'running',
                generationId: data.generationId,
                assistantMessageId: data.assistantMessageId,
              })
            }
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
            if (data.media) {
              const media = normalizeGeneratedMedia(data.media)
              if (media
                && fullMedia.length < MAX_GENERATED_MEDIA_ITEMS
                && !fullMedia.some(item => item.type === media.type && item.url === media.url)) {
                fullMedia.push(media)
                scheduleStreamMessage()
              }
              continue
            }
            if (data.error) {
              terminalError = typeof data.error === "string" ? data.error : "模型生成失败"
              cancelScheduledRender()
              await reader.cancel().catch(() => undefined)
              break streamLoop
            }
            if (data.text) {
              if (typeof window !== "undefined" && window.localStorage?.getItem("mychat_debug_md") === "1") {
                // JSON.stringify makes \n visible in the console
                console.debug("[mychat/md] stream delta", JSON.stringify(data.text))
              }
              fullReply += data.text
              scheduleStreamMessage()
            }
            if (data.thinking) {
              fullThinking += data.thinking
              scheduleStreamMessage()
            }
          } catch {}
        }
      }
    } catch (e: any) {
      if (e?.name === "AbortError" || controller.signal.aborted) aborted = true
      else terminalError = e?.message ?? String(e)
    } finally {
      cancelScheduledRender()
      const hasOutput = !!fullReply || fullMedia.length > 0
      const finalization = planChatStreamFinalization({ hasOutput, aborted, terminalError })

      if (finalization.kind === "persist") {
        if (typeof window !== "undefined" && window.localStorage?.getItem("mychat_debug_md") === "1") {
          console.debug("[mychat/md] final markdown", JSON.stringify(fullReply))
        }
        const streamWarning = finalization.warning
        flushStreamMessage(streamWarning)
        try {
          try {
            await updateMessageFields(convId, msgId, {
              content: fullReply,
              thinking: fullThinking || null,
            })
          } catch {
            await insertMessage(user.id, convId, {
              id: msgId,
              role: "assistant",
              content: fullReply,
              thinking: fullThinking || undefined,
              media: fullMedia.length ? fullMedia : undefined,
              time: "",
            })
          }
          await touchConversation(convId)
          setConversations(prev => prev.map(c => c.id === convId ? { ...c, excerpt: conversationExcerpt(fullReply), date: "今日" } : c))
        } catch {
          const warning = streamWarning
            ? `${streamWarning} 部分结果未能保存，请先下载媒体或复制内容后重试。`
            : "结果已生成，但未能保存。请先下载媒体或复制内容，然后检查网络后重试。"
          flushStreamMessage(warning)
        }
      } else if (finalization.kind === "remove") {
        setConversations(prev => prev.map(c => c.id !== convId ? c : {
          ...c,
          messages: c.messages.filter(message => message.id !== msgId),
        }))
      } else {
        setConversations(prev => prev.map(c => c.id !== convId ? c : {
          ...c,
          messages: c.messages.map(item => item.id !== msgId ? item : {
            ...item,
            content: finalization.message,
            thinking: fullThinking || undefined,
            isError: true,
            outputWarning: undefined,
          }),
        }))
      }

      clearAbort(convId, controller)
      markGeneration(convId, {
        status: aborted ? 'cancelled' : terminalError ? 'error' : 'completed',
        generationId,
        assistantMessageId: msgId,
      })
    }
    return fullReply
  }

  function handleStop() {
    if (!activeId) return
    const controller = abortByConvRef.current.get(activeId)
    const gen = generationByConvRef.current[activeId]
    controller?.abort()
    if (gen?.generationId) {
      fetch(`/api/generations/${gen.generationId}/cancel`, { method: 'POST' }).catch(() => {})
    }
    markGeneration(activeId, { status: 'cancelled' })
    console.info('[mychat/generation] task cancelled', {
      conversationId: activeId,
      generationId: gen?.generationId,
      assistantMessageId: gen?.assistantMessageId,
    })
  }

  async function handleSend(text: string, images?: string[], files?: AttachedFile[]) {
    if (!user || !active) return

    const userMsg: Message = { id: crypto.randomUUID(), role: "user", content: text, time: "此刻", ts: new Date().toISOString(), images: images?.length ? images : undefined, files: files?.map(f => f.name) }
    const msgId = crypto.randomUUID()
    const assistantMsg: Message = { id: msgId, role: "assistant", content: "", thinking: "", time: "此刻" }
    const isFirstExchange = active.messages.length === 0
    const wasDraft = !!active.draft
    const draftId = active.id
    const baseHistory = active.messages

    const generationId = crypto.randomUUID()
    setConversations(prev => prev.map(c => c.id === draftId
      ? { ...c, draft: false, messages: [...c.messages, userMsg, assistantMsg] }
      : c))
    markGeneration(draftId, { status: 'running', generationId, assistantMessageId: msgId })

    let convId = draftId
    try {
      if (wasDraft) {
        const realId = await insertConversation(user.id, "未命名的篇章", active.projectId ?? undefined)
        if (!realId) {
          setConversations(prev => prev.map(c => c.id === draftId
            ? { ...c, draft: true, messages: c.messages.map(m => m.id === msgId ? { ...m, content: "创建会话失败，请重试", isError: true } : m) }
            : c))
          markGeneration(draftId, { status: 'error', generationId, assistantMessageId: msgId })
          return
        }
        convId = realId
        loadedRef.current.add(realId)
        draftIdRef.current = null
        setGenerationByConv(prev => {
          const { [draftId]: _drop, ...rest } = prev
          return {
            ...rest,
            [realId]: { conversationId: realId, status: 'running', generationId, assistantMessageId: msgId },
          }
        })
        setConversations(prev => prev.map(c => c.id === draftId ? { ...c, id: realId } : c))
        setActiveId(realId)
        await insertMessage(user.id, realId, userMsg)
        await insertMessage(user.id, realId, { ...assistantMsg, content: '' }).catch(() => {})
      } else {
        await insertMessage(user.id, convId, userMsg)
        await insertMessage(user.id, convId, { ...assistantMsg, content: '' }).catch(() => {})
      }

      const history = [...baseHistory, userMsg].map(toHistoryMsg)
      const projectCtx = await getProjectContext(active.projectId)
      const controller = new AbortController()
      abortByConvRef.current.set(convId, controller)
      const fullReply = await runAiStream(history, msgId, convId, controller, files?.length ? files : undefined, projectCtx, generationId)

      if (isFirstExchange && fullReply) {
        if (activeEndpoint && activeEndpoint.outputKind !== "chat") {
          const title = text.trim().replace(/\s+/g, " ").slice(0, 14) || "媒体生成"
          setConversations(prev => prev.map(conversation => conversation.id === convId ? { ...conversation, title } : conversation))
          updateConversationTitle(convId, title)
        } else {
          generateTitle(convId, text, fullReply)
        }
      }
    } catch (e) {
      console.error("handleSend failed", e)
      markGeneration(convId, { status: 'error', generationId, assistantMessageId: msgId })
      setConversations(prev => prev.map(c => c.id === convId
        ? { ...c, messages: c.messages.map(m => m.id === msgId ? { ...m, content: m.content || "发送失败，请重试", isError: true } : m) }
        : c))
    }
  }

  async function handleRegenerate() {
    if (!user || !active || isActiveGenerating) return
    setOpenArtifactId(null)
    const msgs = active.messages
    const lastAiIdx = [...msgs].map((m, i) => ({ m, i })).reverse().find(({ m }) => m.role === "assistant")?.i ?? -1
    if (lastAiIdx === -1) return
    const lastAiMsg = msgs[lastAiIdx]

    const historyBeforeAi = msgs.slice(0, lastAiIdx).map(toHistoryMsg)
    const newMsgId = crypto.randomUUID()
    let oldReplyDeleted = false
    const generationId = crypto.randomUUID()
    markGeneration(activeId, { status: 'running', generationId, assistantMessageId: newMsgId })
    try {
      const projectCtx = await getProjectContext(active.projectId)
      await deleteMessageRow(lastAiMsg.id)
      oldReplyDeleted = true
      const retainedMessages = msgs.slice(0, lastAiIdx)
      cacheConversationMessages(activeId, retainedMessages)
      setConversations(prev => prev.map(c => c.id !== activeId ? c : {
        ...c,
        messages: [
          ...retainedMessages,
          { id: newMsgId, role: "assistant" as const, content: "", thinking: "", time: "此刻" },
        ],
      }))
      await insertMessage(user.id, activeId, { id: newMsgId, role: "assistant", content: "", thinking: "", time: "此刻" }).catch(() => {})
      const controller = new AbortController()
      abortByConvRef.current.set(activeId, controller)
      await runAiStream(historyBeforeAi, newMsgId, activeId, controller, undefined, projectCtx, generationId)
    } catch (e) {
      console.error("handleRegenerate failed", e)
      let restored = !oldReplyDeleted
      if (oldReplyDeleted) {
        try {
          await insertMessage(user.id, activeId, lastAiMsg)
          cacheConversationMessages(activeId, msgs)
          restored = true
        } catch {
          restored = false
        }
      }
      markGeneration(activeId, { status: 'error', generationId, assistantMessageId: newMsgId })
      setConversations(prev => prev.map(c => c.id !== activeId ? c : {
        ...c,
        messages: restored
          ? msgs.map(message => message.id === lastAiMsg.id ? {
            ...message,
            outputWarning: "无法开始重新生成，原回复已保留。请检查网络后重试。",
          } : message)
          : c.messages.map(message => message.id === newMsgId ? {
            ...message,
            content: "重新生成失败，且原回复未能恢复。请刷新页面检查历史记录。",
            isError: true,
          } : message),
      }))
    }
  }

  async function regenerateFromUserMessage(userMessageId: string, editedContent?: string) {
    if (!user || !active || isActiveGenerating) return
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
    const assistantMsg: Message = { id: newMsgId, role: "assistant", content: "", thinking: "", time: "此刻" }
    const contentChanged = nextContent !== sourceUser.content.trim()
    let contentUpdated = false
    let branchDeleted = false
    const generationId = crypto.randomUUID()
    markGeneration(convId, { status: 'running', generationId, assistantMessageId: newMsgId })
    try {
      const projectCtx = await getProjectContext(active.projectId)
      if (contentChanged) {
        await updateMessageContent(convId, sourceUser.id, nextContent)
        contentUpdated = true
      }
      await deleteMessageRows(removed.map(message => message.id))
      branchDeleted = true
      const retainedMessages = [...msgs.slice(0, userIdx), nextUser]
      cacheConversationMessages(convId, retainedMessages)
      setConversations(prev => prev.map(c => c.id !== convId ? c : {
        ...c,
        messages: [...retainedMessages, assistantMsg],
      }))
      await insertMessage(user.id, convId, { ...assistantMsg, content: '' }).catch(() => {})
      const history = retainedMessages.map(toHistoryMsg)
      const controller = new AbortController()
      abortByConvRef.current.set(convId, controller)
      await runAiStream(history, newMsgId, convId, controller, undefined, projectCtx, generationId)
    } catch (e) {
      console.error("regenerateFromUserMessage failed", e)
      let restored = !branchDeleted
      if (branchDeleted) {
        try {
          if (contentUpdated) await updateMessageContent(convId, sourceUser.id, sourceUser.content)
          for (const message of removed) await insertMessage(user.id, convId, message)
          cacheConversationMessages(convId, msgs)
          restored = true
        } catch {
          restored = false
        }
      }
      markGeneration(convId, { status: 'error' })
      setConversations(prev => prev.map(c => c.id !== convId ? c : {
        ...c,
        messages: restored ? (() => {
          const warningTarget = [...removed].reverse().find(message => message.role === "assistant")?.id
          const restoredMessages = msgs.map(message => message.id === sourceUser.id && contentUpdated && !branchDeleted
            ? { ...message, content: nextContent }
            : message.id === warningTarget
              ? { ...message, outputWarning: "无法开始重新回复，原有内容已保留。请检查网络后重试。" }
              : message)
          return warningTarget ? restoredMessages : [...restoredMessages, {
            id: newMsgId,
            role: "assistant" as const,
            content: "无法开始重新回复，请检查网络后重试。",
            time: "此刻",
            isError: true,
          }]
        })() : c.messages.map(message => message.id === newMsgId ? {
          ...message,
          content: "重新回复失败，且原有分支未能恢复。请刷新页面检查历史记录。",
          isError: true,
        } : message),
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
    modelEndpoints,
    activeEndpointId,
    onEndpointSelect: handleEndpointSelect,
    onEndpointCreated: handleEndpointCreated,
    onEndpointUpdated: handleEndpointUpdated,
    onEndpointDeleted: handleEndpointDeleted,
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
              isLoading={isActiveGenerating}
              onOpenArtifact={setOpenArtifactId}
              openArtifactId={openArtifactId}
            />
          ) : (
            <EmptyState />
          )}
        </div>

        <ChatInput
          onSend={handleSend}
          activeTier={activeTier}
          onTierChange={handleTierChange}
          customEndpoints={modelEndpoints}
          activeEndpointId={activeEndpointId}
          onEndpointChange={handleEndpointSelect}
          mobile={mobile}
          searchMode={searchMode}
          onSearchModeChange={setSearchMode}
          deepResearch={deepResearch}
          onDeepResearchChange={setDeepResearch}
          historyRetrieval={historyRetrieval}
          onHistoryRetrievalChange={setHistoryRetrieval}
          imageGenMode={imageGenMode}
          onImageGenModeChange={setImageGenMode}
          platformImageAvailable={platformImageAvailable && !activeEndpointId}
          isLoading={isActiveGenerating}
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

function EmptyState() {
  return (
    <div className="mx-auto flex h-full max-w-[40rem] flex-col items-center justify-center px-8 text-center">
      <p className="text-[14px] italic text-muted-foreground/60">说点什么开始对谈</p>
    </div>
  )
}
