"use client"

import { useMemo, useRef, useState, useEffect } from "react"
import { type Conversation, type Message, type Tier, TIERS, TIER_MAP } from "@/lib/chat-data"
import { type Memory } from "@/lib/memory-data"
import {
  fetchMemories, insertMemory, updateMemory, deleteMemoryRow,
  fetchConversations, insertConversation, updateConversationTitle, touchConversation, deleteConversationRow,
  setConversationStarred, setConversationPinned, setConversationProject,
  fetchMessages, insertMessage, lastExcerpt, conversationExcerpt,
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
  const [activeTier, setActiveTier] = useState<Tier>("绝句")
  const [openArtifactId, setOpenArtifactId] = useState<string | null>(null)
  // 顶部对话菜单（Claude 式「项目名 / 标题 ⌄」）：触发按钮锚点 + 顶部就地改名
  const [headerMenuAnchor, setHeaderMenuAnchor] = useState<{ bottom: number; left: number } | null>(null)
  const [headerRenaming, setHeaderRenaming] = useState(false)
  const [projects, setProjects] = useState<Project[]>([])

  const abortRef = useRef<AbortController | null>(null)
  const loadedRef = useRef<Set<string>>(new Set())
  const projectCtxRef = useRef<Map<string, ProjectContext>>(new Map())
  const draftIdRef = useRef<string | null>(null)   // 当前本地草稿会话的 id（最多一个）

  // OAuth 在 Code 板块内发起，授权回跳后带 ?github=connected：自动重新打开 Code
  useEffect(() => {
    if (typeof window !== "undefined" && window.location.search.includes("github=")) {
      if (window.location.search.includes("github=connected")) setCodeOpen(true)
      window.history.replaceState({}, "", window.location.pathname)
    }
  }, [])

  // 检查登录状态，并监听登录/登出
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

  // 登录后从云端加载记忆 + 对话；登出则清空
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
      // 旧 bug 留下的"空会话"（确知 0 条消息）：不仅前端隐藏，更直接删库彻底清掉，根治"清不掉的死会话"。
      // count 拿不到（undefined）的一律按"非空"对待，绝不误删/误藏。
      for (const c of convs) if (c.msgCount === 0) deleteConversationRow(c.id)
      const real = convs.filter(c => c.msgCount !== 0)
      if (real.length === 0) {
        // 没有任何真实会话：起一个本地草稿（先不写库），用户发首条消息时才真正创建
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
    } catch { /* 标题生成失败不影响主流程 */ }
  }

  // ── 核心：运行 AI 流式响应，被 handleSend 和 handleRegenerate 共用 ──
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

    let fullReply = "", fullThinking = "", hadError = false
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
          thinking: fullThinking || undefined,
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
          memories: memoryEnabled && memories.length > 0 ? memories : undefined,
          attachments: attachments && attachments.length > 0 ? attachments : undefined,
          searchMode,
          deepResearch,
          project: projectCtx,
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
              if (mem.ok) {
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
            if (data.thinking) {
              fullThinking += data.thinking
              scheduleStreamMessage()
            }
          } catch { /* skip bad event */ }
        }
      }

      if (!hadError) {
        if (rafId !== null) cancelAnimationFrame(rafId)
        flushStreamMessage()
      }

      if (!hadError && fullReply) {
        insertMessage(user.id, convId, { id: msgId, role: "assistant", content: fullReply, thinking: fullThinking || undefined, time: "" })
        touchConversation(convId)
        setConversations(prev => prev.map(c => c.id === convId ? { ...c, excerpt: conversationExcerpt(fullReply), date: "今日" } : c))
      }
    } catch (e: any) {
      if (e?.name === "AbortError") return fullReply  // 用户主动停止，保留已有内容
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

  // ── 停止生成 ──
  function handleStop() {
    abortRef.current?.abort()
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

    // 1) 先把用户气泡 + 空 AI 占位立刻显示出来——必须抢在任何网络 await 之前。
    //    否则草稿首轮要等落库往返才看到自己刚发的话（这正是"发出去整页空白、等回复完才一起冒出来"的根因）。
    setConversations(prev => prev.map(c => c.id === draftId
      ? { ...c, draft: false, messages: [...c.messages, userMsg, assistantMsg] }
      : c))
    setIsLoading(true)

    // 2) 草稿此刻才落库（在后台进行，不阻塞上面的显示）；拿到真实 id 后把临时 id 悄悄换掉
    let convId = draftId
    // 整段用 try/catch 兜底：落库 / 取项目背景 等任一 await 抛错（如网络抖动）时，
    // 绝不能让 isLoading 卡在 true、界面静默卡死——这正是"消息发出却像消失了，退出重进才好"的根因。
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

      const history = [...baseHistory, userMsg].map(m => ({
        id: m.id,
        role: m.role,
        content: m.content,
        ...(m.images?.length ? { images: m.images } : {}),
        ...(m.imageSummary ? { imageSummary: m.imageSummary } : {}),
        ...(m.ts ? { ts: m.ts } : {}),
      }))

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

  // ── 重新生成最后一条 AI 回复 ──
  async function handleRegenerate() {
    if (!user || !active || isLoading) return
    setOpenArtifactId(null)
    const msgs = active.messages
    const lastAiIdx = [...msgs].map((m, i) => ({ m, i })).reverse().find(({ m }) => m.role === "assistant")?.i ?? -1
    if (lastAiIdx === -1) return
    const lastAiMsg = msgs[lastAiIdx]

    // 历史 = 最后一条 AI 消息之前的所有消息
    const historyBeforeAi = msgs.slice(0, lastAiIdx).map(m => ({
      id: m.id, role: m.role, content: m.content,
      ...(m.images?.length ? { images: m.images } : {}),
      ...(m.imageSummary ? { imageSummary: m.imageSummary } : {}),
      ...(m.ts ? { ts: m.ts } : {}),
    }))

    const newMsgId = crypto.randomUUID()
    setConversations(prev => prev.map(c => c.id !== activeId ? c : {
      ...c,
      messages: [
        ...msgs.slice(0, lastAiIdx),
        { id: newMsgId, role: "assistant" as const, content: "", thinking: "", time: "此刻" },
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

  async function handleDelete(id: string) {
    deleteConversationRow(id)
    loadedRef.current.delete(id)
    if (draftIdRef.current === id) draftIdRef.current = null
    const remaining = conversations.filter(c => c.id !== id)
    if (remaining.length === 0) {
      // 删到空了：起一个本地草稿，别再写库
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
    // 已有一个空草稿（或当前正停在草稿上）：切过去即可，绝不重复创建——天然防连点
    if (draftIdRef.current) { setActiveId(draftIdRef.current); return }
    const id = crypto.randomUUID()
    draftIdRef.current = id
    setConversations(prev => [{ id, title: "未命名的篇章", excerpt: "", date: "今日", messages: [], draft: true }, ...prev])
    setActiveId(id)
  }

  // ── 会话菜单：收藏 / 置顶 / 改名 / 移入移出项目 ──
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

  // ── 项目 ──
  // 取项目背景（指令 + 资料）；按 projectId 缓存，资料/指令变动时清缓存
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
    // 该项目下的对谈本地解绑（DB 端 ON DELETE SET NULL 已处理）
    setConversations(prev => prev.map(c => c.projectId === id ? { ...c, projectId: null } : c))
    deleteProjectRow(id)
  }
  function handleNewInProject(projectId: string) {
    if (!user) return
    setDrawerOpen(false)
    // 复用唯一草稿并归到此项目；没有草稿就新建一个带项目归属的草稿（同样发首条消息才落库）
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
      const prepared = await prepareFile(file)  // PDF 在前端已提取文字，text 字段已填好
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
    projectCtxRef.current.clear()  // 不知归属哪个项目，直接清空缓存（仅是优化缓存）
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
      <main className={cn("flex min-w-0 flex-1 flex-col overflow-hidden", !mobile && "ml-2")}>
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
              isLoading={isLoading}
              onOpenArtifact={setOpenArtifactId}
              openArtifactId={openArtifactId}
            />
          ) : (
            <EmptyState endpointName={activeName} />
          )}
          {isLoading && (
            <div className="mx-auto max-w-[44rem] px-5 pb-4 text-sm italic md:px-10">
              <span className="thinking-flow">正在{activeName}思考……</span>
            </div>
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
          isLoading={isLoading}
          onStop={handleStop}
        />
      </main>
    )
  }

  if (!authChecked) return <div className="h-dvh w-full bg-background paper-grain" />
  if (!user) return <LoginScreen />

  // 当前打开的 artifact 面板数据（从消息原始全文实时拆分，流式时自动更新）
  const openMsg = openArtifactId ? active?.messages.find(m => m.id === openArtifactId) : null
  const openArt = openMsg ? parseArtifact(openMsg.content) : null
  const showArt = !!(openArt && openArt.raw !== null)

  return (
    <>
      {codeOpen && <CodeConsole userId={user.id} onExit={() => setCodeOpen(false)} />}
      <div className="hidden h-dvh min-h-0 w-full overflow-hidden bg-background p-4 paper-grain md:flex">
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
          {/* 半屏遮罩：露出后面的对话，点一下收起 */}
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
