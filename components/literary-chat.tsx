"use client"

import { useMemo, useRef, useState, useEffect } from "react"
import { type Conversation, type Message, type Tier, TIERS } from "@/lib/chat-data"
import { type Memory } from "@/lib/memory-data"
import {
  fetchMemories, insertMemory, updateMemory, deleteMemoryRow,
  fetchConversations, insertConversation, updateConversationTitle, touchConversation, deleteConversationRow,
  fetchMessages, insertMessage, lastExcerpt,
  deleteMessageRow,
} from "@/lib/db"
import { type AttachedFile } from "@/lib/file-extract"
import { ConversationSidebar } from "@/components/conversation-sidebar"
import { MessageList } from "@/components/message-list"
import { ChatInput } from "@/components/chat-input"
import { LoginScreen } from "@/components/login-screen"
import { createClient } from "@/lib/supabase/client"
import type { User } from "@supabase/supabase-js"
import { cn } from "@/lib/utils"
import { PanelLeft, X } from "lucide-react"
import { parseArtifact, artifactTitle } from "@/lib/artifact"
import { ArtifactPanel } from "@/components/artifact-panel"

type GithubContext = { repo: string; context: string }
type HistoryMsg = { role: string; content: string; images?: string[] }

export function LiteraryChat() {
  const [user, setUser] = useState<User | null>(null)
  const [authChecked, setAuthChecked] = useState(false)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState("")
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [githubContext, setGithubContext] = useState<GithubContext | null>(null)
  const [githubConnected, setGithubConnected] = useState(false)
  const [githubLogin, setGithubLogin] = useState<string | null>(null)
  const [memories, setMemories] = useState<Memory[]>([])
  const [webSearch, setWebSearch] = useState(false)
  const [activeTier, setActiveTier] = useState<Tier>("绝句")
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [openArtifactId, setOpenArtifactId] = useState<string | null>(null)

  const abortRef = useRef<AbortController | null>(null)
  const loadedRef = useRef<Set<string>>(new Set())

  // 页面加载时检查 GitHub 连接状态
  useEffect(() => {
    fetch("/api/github/status")
      .then(r => r.json())
      .then(d => { setGithubConnected(!!d.connected); setGithubLogin(d.login ?? null) })
      .catch(() => {})
    if (typeof window !== "undefined" && window.location.search.includes("github=")) {
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
      setEndpoints([])
      setActiveId("")
      setActiveEndpointId("")
      loadedRef.current = new Set()
      return
    }
    let cancelled = false
    ;(async () => {
      const [convs, mems] = await Promise.all([fetchConversations(), fetchMemories()])
      if (cancelled) return
      setMemories(mems)
      try {
        const saved = localStorage.getItem("chat_active_tier") as Tier | null
        if (saved && TIERS.some(t => t.id === saved)) setActiveTier(saved)
      } catch {}
      if (convs.length === 0) {
        const id = await insertConversation(user.id, "未命名的篇章")
        if (cancelled || !id) return
        loadedRef.current.add(id)
        setConversations([{ id, title: "未命名的篇章", excerpt: "", date: "今日", messages: [] }])
        setActiveId(id)
      } else {
        setConversations(convs)
        setActiveId(convs[0].id)
        const msgs = await fetchMessages(convs[0].id)
        if (cancelled) return
        loadedRef.current.add(convs[0].id)
        setConversations(prev => prev.map(c => c.id === convs[0].id ? { ...c, messages: msgs, excerpt: lastExcerpt(msgs) } : c))
      }
    })()
    return () => { cancelled = true }
  }, [user])

  function handleTierChange(t: Tier) {
    setActiveTier(t)
    try { localStorage.setItem("chat_active_tier", t) } catch {}
  }

  const activeName = activeTier

  const active = useMemo(
    () => conversations.find(c => c.id === activeId),
    [conversations, activeId],
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
  ): Promise<string> {
    if (!user) { setIsLoading(false); return "" }

    const prefix: HistoryMsg[] = []
    if (githubContext) {
      prefix.push({ role: "user", content: `GitHub 仓库上下文 (${githubContext.repo}):\n${githubContext.context.slice(0, 2000)}` })
      prefix.push({ role: "assistant", content: "已了解仓库信息。" })
    }
    const history = [...prefix, ...messages]

    let fullReply = "", fullThinking = ""
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tier: activeTier,
          messages: history,
          memories: memories.length > 0 ? memories : undefined,
          attachments: attachments && attachments.length > 0 ? attachments : undefined,
          webSearch,
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
                if (mem.action === "create" && mem.id) setMemories(prev => [...prev, { id: mem.id, content: mem.content ?? "" }])
                else if (mem.action === "update" && mem.id) setMemories(prev => prev.map(x => x.id === mem.id ? { ...x, content: mem.content ?? x.content } : x))
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
            if (data.sheetMusic) {
              setConversations(prev => prev.map(c => c.id !== convId ? c : {
                ...c,
                messages: c.messages.map(m => m.id !== msgId ? m : { ...m, sheetMusicNotes: [...(m.sheetMusicNotes ?? []), { ...data.sheetMusic, status: "done" }] }),
              }))
              continue
            }
            if (data.text) fullReply += data.text
            if (data.thinking) fullThinking += data.thinking
            setConversations(prev => prev.map(c => c.id !== convId ? c : {
              ...c,
              messages: c.messages.map(m => m.id !== msgId ? m : {
                ...m,
                content: data.error ? data.error : fullReply,
                thinking: fullThinking || undefined,
                isError: data.error ? true : m.isError,
              }),
            }))
          } catch { /* skip bad event */ }
        }
      }

      if (fullReply) {
        insertMessage(user.id, convId, { id: msgId, role: "assistant", content: fullReply, thinking: fullThinking || undefined, time: "" })
        touchConversation(convId)
        setConversations(prev => prev.map(c => c.id === convId ? { ...c, excerpt: fullReply.slice(0, 60), date: "今日" } : c))
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
    const userMsg: Message = { id: crypto.randomUUID(), role: "user", content: text, time: "此刻", images, files: files?.map(f => f.name) }

    const convId = activeId
    const msgId = crypto.randomUUID()
    const isFirstExchange = active.messages.length === 0
    setConversations(prev => prev.map(c => c.id === convId ? {
      ...c, messages: [...c.messages, userMsg, { id: msgId, role: "assistant", content: "", thinking: "", time: "此刻" }]
    } : c))
    insertMessage(user.id, convId, userMsg)

    const history = [...active.messages, userMsg].map(m => ({
      role: m.role,
      content: m.content,
      ...(m.images?.length ? { images: m.images } : {}),
    }))

    setIsLoading(true)
    const controller = new AbortController()
    abortRef.current = controller
    const fullReply = await runAiStream(history, msgId, convId, controller, files)

    if (isFirstExchange && fullReply) generateTitle(convId, text, fullReply)
    // 清掉引用
    setReplyTo(null)
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
      role: m.role, content: m.content,
      ...(m.images?.length ? { images: m.images } : {}),
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
    const controller = new AbortController()
    abortRef.current = controller
    await runAiStream(historyBeforeAi, newMsgId, activeId, controller)
  }

  // ── 引用回复 ──
  function handleReply(text: string) {
    setReplyTo(text.slice(0, 400))
  }

  async function handleDelete(id: string) {
    deleteConversationRow(id)
    loadedRef.current.delete(id)
    const remaining = conversations.filter(c => c.id !== id)
    if (remaining.length === 0) {
      if (!user) return
      const newId = await insertConversation(user.id, "未命名的篇章")
      if (!newId) return
      loadedRef.current.add(newId)
      setConversations([{ id: newId, title: "未命名的篇章", excerpt: "", date: "今日", messages: [] }])
      setActiveId(newId)
      return
    }
    setConversations(remaining)
    if (activeId === id) {
      const nextId = remaining[0].id
      setActiveId(nextId)
      if (!loadedRef.current.has(nextId)) {
        loadedRef.current.add(nextId)
        const msgs = await fetchMessages(nextId)
        setConversations(prev => prev.map(c => c.id === nextId ? { ...c, messages: msgs, excerpt: lastExcerpt(msgs) } : c))
      }
    }
  }

  async function handleNew() {
    if (!user) return
    const id = await insertConversation(user.id, "未命名的篇章")
    if (!id) return
    loadedRef.current.add(id)
    setConversations(prev => [{ id, title: "未命名的篇章", excerpt: "", date: "今日", messages: [] }, ...prev])
    setActiveId(id)
    setDrawerOpen(false)
  }

  async function handleMemoryAdd(content: string) {
    if (!user) return
    const mem = await insertMemory(user.id, content)
    if (mem) setMemories(prev => [...prev, mem])
  }
  async function handleMemoryEdit(id: string, content: string) {
    setMemories(prev => prev.map(m => m.id === id ? { ...m, content } : m))
    updateMemory(id, content)
  }
  async function handleMemoryDelete(id: string) {
    setMemories(prev => prev.filter(m => m.id !== id))
    deleteMemoryRow(id)
  }

  async function handleGithubDisconnect() {
    await fetch("/api/auth/github/disconnect", { method: "POST" })
    setGithubConnected(false)
    setGithubLogin(null)
    setGithubContext(null)
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
    userEmail: user?.email ?? "",
    onLogout: handleLogout,
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
            className="inline-flex rounded-full p-2 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            aria-label={mobile ? "打开对话列表" : "收起侧栏"}
          >
            <PanelLeft className="size-5" />
          </button>
          <span className="min-w-0 flex-1 truncate text-sm italic tracking-wider text-muted-foreground">{active?.title}</span>
        </header>

        <div
          ref={mobile ? mobileScrollRef : desktopScrollRef}
          className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain"
        >
          {active && active.messages.length > 0 ? (
            <MessageList
              conversation={active}
              onRegenerate={handleRegenerate}
              onReply={handleReply}
              isLoading={isLoading}
              onOpenArtifact={setOpenArtifactId}
              openArtifactId={openArtifactId}
            />
          ) : (
            <EmptyState endpointName={activeName} />
          )}
          {isLoading && (
            <div className="mx-auto max-w-[44rem] px-5 pb-4 text-sm italic text-muted-foreground animate-pulse md:px-10">
              {activeName} 正在落笔……
            </div>
          )}
        </div>

        <ChatInput
          onSend={handleSend}
          activeTier={activeTier}
          onTierChange={handleTierChange}
          mobile={mobile}
          githubContext={githubContext}
          onGithubConnect={(ctx) => { setGithubContext(ctx); if (ctx) setGithubConnected(true) }}
          githubConnected={githubConnected}
          githubLogin={githubLogin}
          onGithubDisconnect={handleGithubDisconnect}
          webSearch={webSearch}
          onWebSearchChange={setWebSearch}
          isLoading={isLoading}
          onStop={handleStop}
          replyTo={replyTo}
          onClearReply={() => setReplyTo(null)}
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
      <div className="hidden h-dvh min-h-0 w-full overflow-hidden bg-background p-4 paper-grain md:flex">
        <div className={cn("shrink-0 overflow-hidden transition-[width] duration-300 ease-in-out", sidebarCollapsed ? "w-0" : "w-[20rem]")}>
          <div className="h-full w-[20rem] overflow-hidden border-r border-border/50 bg-sidebar/40">
            <ConversationSidebar {...sidebarProps} />
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
            aria-label="关闭侧栏"
            onClick={() => setDrawerOpen(false)}
            className={cn("absolute inset-0 h-full w-full bg-foreground/30 transition-opacity", drawerOpen ? "opacity-100" : "opacity-0")}
          />
          <div className={cn(
            "absolute left-0 top-0 h-dvh w-[min(20rem,88vw)] overflow-hidden rounded-r-2xl border-r border-border bg-sidebar shadow-xl transition-transform",
            drawerOpen ? "translate-x-0" : "-translate-x-full",
          )}>
            <ConversationSidebar {...sidebarProps} />
          </div>
          {drawerOpen && (
            <button
              onClick={() => setDrawerOpen(false)}
              className="absolute right-4 top-[max(1rem,env(safe-area-inset-top))] z-50 rounded-full bg-card p-2 text-foreground shadow"
              aria-label="关闭对话列表"
            >
              <X className="size-5" />
            </button>
          )}
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
