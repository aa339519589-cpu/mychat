"use client"

import { useMemo, useRef, useState, useEffect } from "react"
import { CONVERSATIONS, type Conversation, type Message, type Endpoint } from "@/lib/chat-data"
import { loadMemories, saveMemories, type Memory } from "@/lib/memory-data"
import { ConversationSidebar } from "@/components/conversation-sidebar"
import { MessageList } from "@/components/message-list"
import { ChatInput } from "@/components/chat-input"
import { LoginScreen } from "@/components/login-screen"
import { createClient } from "@/lib/supabase/client"
import type { User } from "@supabase/supabase-js"
import { cn } from "@/lib/utils"
import { PanelLeft, X } from "lucide-react"

type GithubContext = { repo: string; context: string }

export function LiteraryChat() {
  const [user, setUser] = useState<User | null>(null)
  const [authChecked, setAuthChecked] = useState(false)
  const [conversations, setConversations] = useState<Conversation[]>(CONVERSATIONS)
  const [activeId, setActiveId] = useState(CONVERSATIONS[0].id)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [githubContext, setGithubContext] = useState<GithubContext | null>(null)
  const [memories, setMemories] = useState<Memory[]>([])
  const [webSearch, setWebSearch] = useState(false)

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

  const [endpoints, setEndpoints] = useState<Endpoint[]>([])
  const [activeEndpointId, setActiveEndpointId] = useState("")

  useEffect(() => {
    setMemories(loadMemories())
  }, [])

  useEffect(() => {
    try {
      let loadedEndpoints: Endpoint[] = []
      const saved = localStorage.getItem("chat_endpoints")
      if (saved) {
        const parsed = JSON.parse(saved)
        if (Array.isArray(parsed)) {
          loadedEndpoints = parsed.map((endpoint: Endpoint) => ({
            ...endpoint,
            name: String(endpoint.name ?? "").trim(),
            baseUrl: String(endpoint.baseUrl ?? "").trim(),
            apiKey: String(endpoint.apiKey ?? "").trim(),
            model: String(endpoint.model ?? "").trim(),
          }))
          setEndpoints(loadedEndpoints)
          localStorage.setItem("chat_endpoints", JSON.stringify(loadedEndpoints))
        }
      }

      const savedActive = localStorage.getItem("chat_active_endpoint")
      const nextActive = savedActive && loadedEndpoints.some(endpoint => endpoint.id === savedActive)
        ? savedActive
        : loadedEndpoints[0]?.id ?? ""
      setActiveEndpointId(nextActive)
      if (nextActive) localStorage.setItem("chat_active_endpoint", nextActive)
    } catch { /* storage unavailable */ }
  }, [])

  function handleEndpointsChange(eps: Endpoint[]) {
    setEndpoints(eps)
    try { localStorage.setItem("chat_endpoints", JSON.stringify(eps)) } catch { /* storage unavailable */ }
  }

  function handleActiveEndpointChange(id: string) {
    setActiveEndpointId(id)
    try { localStorage.setItem("chat_active_endpoint", id) } catch { /* storage unavailable */ }
  }

  const activeEndpoint = endpoints.find(e => e.id === activeEndpointId)
  const activeName = activeEndpoint?.name ?? "笔友"

  const active = useMemo(
    () => conversations.find(c => c.id === activeId)!,
    [conversations, activeId],
  )

  const desktopScrollRef = useRef<HTMLDivElement>(null)
  const mobileScrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    for (const el of [desktopScrollRef.current, mobileScrollRef.current]) {
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
    }
  }, [active?.messages?.length, activeId])

  async function generateTitle(convId: string, userText: string, aiText: string) {
    if (!activeEndpoint) return
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          protocol: activeEndpoint.protocol,
          baseUrl: activeEndpoint.baseUrl,
          apiKey: activeEndpoint.apiKey,
          model: activeEndpoint.model,
          messages: [{ role: "user", content: `根据下面这段对话，给出一个10字以内的标题，只输出标题本身，不要引号和标点：\n用户：${userText.slice(0, 80)}\nAI：${aiText.slice(0, 80)}` }],
        }),
      })
      if (!res.body) return
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let title = ""
      let buf = ""
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const parts = buf.split("\n\n")
        buf = parts.pop() ?? ""
        for (const part of parts) {
          const line = part.trim()
          if (line.startsWith("data: ") && line !== "data: [DONE]") {
            try { const d = JSON.parse(line.slice(6)); if (d.text) title += d.text } catch {}
          }
        }
      }
      const clean = title.trim().replace(/^["'「『]|["'」』]$/g, "").slice(0, 20)
      if (clean) setConversations(prev => prev.map(c => c.id === convId ? { ...c, title: clean } : c))
    } catch { /* 标题生成失败不影响主流程 */ }
  }

  async function updateMemories(userText: string, aiText: string, currentMemories: Memory[]) {
    if (!activeEndpoint) return
    try {
      const existing = currentMemories.length
        ? currentMemories.map(m => `[${m.id}] ${m.content}`).join('\n')
        : '（空）'
      const prompt = `你是记忆管理助手。根据下面的对话内容，判断是否有值得长期记住的用户信息（姓名、兴趣、偏好、计划、习惯等）。

当前记忆：
${existing}

对话：
用户：${userText.slice(0, 300)}
AI：${aiText.slice(0, 300)}

请以JSON数组格式输出需要执行的操作。如果没有需要更新的，输出空数组 []。
格式：
[
  {"action":"create","content":"用户叫小明"},
  {"action":"delete","id":"abc123"}
]
只输出JSON，不要任何其他文字。`

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          protocol: activeEndpoint.protocol,
          baseUrl: activeEndpoint.baseUrl,
          apiKey: activeEndpoint.apiKey,
          model: activeEndpoint.model,
          messages: [{ role: "user", content: prompt }],
        }),
      })
      if (!res.body) return
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let raw = ""
      let buf = ""
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const parts = buf.split("\n\n")
        buf = parts.pop() ?? ""
        for (const part of parts) {
          const line = part.trim()
          if (line.startsWith("data: ") && line !== "data: [DONE]") {
            try { const d = JSON.parse(line.slice(6)); if (d.text) raw += d.text } catch {}
          }
        }
      }

      const jsonMatch = raw.match(/\[[\s\S]*\]/)
      if (!jsonMatch) return
      const ops: { action: string; content?: string; id?: string }[] = JSON.parse(jsonMatch[0])
      if (!Array.isArray(ops) || ops.length === 0) return

      setMemories(prev => {
        let next = [...prev]
        for (const op of ops) {
          if (op.action === "create" && op.content?.trim()) {
            next.push({ id: `m-${Date.now()}-${Math.random().toString(36).slice(2,6)}`, content: op.content.trim() })
          } else if (op.action === "delete" && op.id) {
            next = next.filter(m => m.id !== op.id)
          }
        }
        saveMemories(next)
        return next
      })
    } catch { /* 记忆更新失败不影响主流程 */ }
  }

  async function handleSend(text: string, images?: string[]) {
    const userMsg: Message = { id: `u-${Date.now()}`, role: "user", content: text, time: "此刻", images }

    if (!activeEndpoint) {
      setConversations(prev => prev.map(c => c.id === activeId ? {
        ...c, messages: [...c.messages, userMsg, { id: `e-${Date.now()}`, role: "assistant", content: "请先点击左下角齿轮图标，添加一个 API 端点。", time: "此刻", isError: true }]
      } : c))
      return
    }

    const msgId = `a-${Date.now()}`
    const isFirstExchange = active.messages.length === 0
    setConversations(prev => prev.map(c => c.id === activeId ? {
      ...c, messages: [...c.messages, userMsg, { id: msgId, role: "assistant", content: "", thinking: "", time: "此刻" }]
    } : c))

    setIsLoading(true)
    try {
      // 联网搜索：先获取搜索结果，作为上下文注入
      let searchContext = ""
      if (webSearch && text.trim()) {
        try {
          const sr = await fetch("/api/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: text }),
          })
          if (sr.ok) {
            const sd = await sr.json()
            if (sd.context) searchContext = sd.context
          }
        } catch { /* 搜索失败不阻断对话 */ }
      }

      const baseHistory = [...active.messages, userMsg].map(m => ({
        role: m.role,
        content: m.content,
        ...(m.images?.length ? { images: m.images } : {}),
      }))
      const prefixMessages: { role: "user" | "assistant"; content: string }[] = []
      if (githubContext) {
        prefixMessages.push({ role: "user", content: `GitHub 仓库上下文 (${githubContext.repo}):\n${githubContext.context.slice(0, 2000)}` })
        prefixMessages.push({ role: "assistant", content: "已了解仓库信息。" })
      }
      if (searchContext) {
        prefixMessages.push({ role: "user", content: `以下是联网搜索的最新结果，请在回答时参考：\n${searchContext}` })
        prefixMessages.push({ role: "assistant", content: "好的，我已参考搜索结果。" })
      }
      const history = [...prefixMessages, ...baseHistory]

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          protocol: activeEndpoint.protocol,
          baseUrl: activeEndpoint.baseUrl,
          apiKey: activeEndpoint.apiKey,
          model: activeEndpoint.model,
          messages: history,
          memories: memories.length > 0 ? memories : undefined,
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
      let fullReply = ""

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const parts = buf.split("\n\n")
        buf = parts.pop() ?? ""

        for (const part of parts) {
          const line = part.trim()
          if (!line || line === "data: [DONE]") continue
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6))
              if (data.text) fullReply += data.text
              setConversations(prev => prev.map(c => c.id !== activeId ? c : {
                ...c,
                messages: c.messages.map(m => m.id !== msgId ? m : {
                  ...m,
                  content: data.error ? data.error : m.content + (data.text ?? ""),
                  thinking: data.thinking !== undefined ? (m.thinking ?? "") + data.thinking : m.thinking,
                  isError: data.error ? true : m.isError,
                }),
              }))
            } catch { /* skip */ }
          }
        }
      }

      // 第一次对话完成后自动生成标题
      if (isFirstExchange && fullReply) {
        generateTitle(activeId, text, fullReply)
      }
      // 后台更新记忆
      if (fullReply) {
        updateMemories(text, fullReply, memories)
      }
    } catch (e: any) {
      setConversations(prev => prev.map(c => c.id !== activeId ? c : {
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
  }

  function handleDelete(id: string) {
    setConversations(prev => {
      const next = prev.filter(c => c.id !== id)
      if (next.length === 0) {
        const fresh = { id: `c-${Date.now()}`, title: "未命名的篇章", excerpt: "一页尚待书写的空白……", date: "今日", messages: [] }
        if (activeId === id) setActiveId(fresh.id)
        return [fresh]
      }
      if (activeId === id) setActiveId(next[0].id)
      return next
    })
  }

  function handleNew() {
    const id = `c-${Date.now()}`
    setConversations(prev => [{ id, title: "未命名的篇章", excerpt: "一页尚待书写的空白……", date: "今日", messages: [] }, ...prev])
    setActiveId(id)
    setDrawerOpen(false)
  }

  async function handleLogout() {
    const supabase = createClient()
    await supabase.auth.signOut()
    setUser(null)
  }

  const sidebarProps = {
    conversations, activeId,
    onSelect: (id: string) => { setActiveId(id); setDrawerOpen(false) },
    onNew: handleNew,
    onDelete: handleDelete,
    endpoints, activeEndpointId,
    onEndpointsChange: handleEndpointsChange,
    onActiveEndpointChange: handleActiveEndpointChange,
    memories,
    onMemoriesChange: (mems: Memory[]) => setMemories(mems),
    userEmail: user?.email ?? "",
    onLogout: handleLogout,
  }

  function renderChatPane(mobile: boolean) {
    return (
      <main className={cn("flex min-w-0 flex-1 flex-col overflow-hidden", !mobile && "ml-2")}>
        <header className={cn(
          "z-10 flex shrink-0 items-center gap-3 bg-background/90 backdrop-blur-sm",
          mobile
            ? "px-4 pb-2 pt-[max(0.75rem,env(safe-area-inset-top))]"
            : "px-8 py-4",
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
          {active?.messages?.length > 0 ? (
            <MessageList conversation={active} endpointName={activeName} />
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
          endpoints={endpoints}
          activeEndpointId={activeEndpointId}
          onEndpointChange={handleActiveEndpointChange}
          mobile={mobile}
          githubContext={githubContext}
          onGithubConnect={setGithubContext}
          webSearch={webSearch}
          onWebSearchChange={setWebSearch}
        />
      </main>
    )
  }

  // 还没查完登录状态：显示空白过渡，避免闪烁
  if (!authChecked) {
    return <div className="h-dvh w-full bg-background paper-grain" />
  }
  // 未登录：显示登录页
  if (!user) {
    return <LoginScreen />
  }

  return (
    <>
      <div className="hidden h-dvh min-h-0 w-full overflow-hidden bg-background p-4 paper-grain md:flex">
        <div className={cn("shrink-0 overflow-hidden transition-[width] duration-300 ease-in-out", sidebarCollapsed ? "w-0" : "w-[20rem]")}>
          <div className="h-full w-[20rem] overflow-hidden border-r border-border/50 bg-sidebar/40">
            <ConversationSidebar {...sidebarProps} />
          </div>
        </div>
        {renderChatPane(false)}
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
