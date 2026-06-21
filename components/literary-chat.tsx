"use client"

import { useMemo, useRef, useState, useEffect } from "react"
import { CONVERSATIONS, DEFAULT_MEMORY_CONFIG, type Conversation, type Message, type Endpoint, type MemoryConfig } from "@/lib/chat-data"
import { ConversationSidebar } from "@/components/conversation-sidebar"
import { MessageList } from "@/components/message-list"
import { ChatInput } from "@/components/chat-input"
import { cn } from "@/lib/utils"
import { PanelLeft, X } from "lucide-react"

function createMemoryUserId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID()
  return `browser-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function LiteraryChat({ memoryAvailable }: { memoryAvailable: boolean }) {
  const [conversations, setConversations] = useState<Conversation[]>(CONVERSATIONS)
  const [activeId, setActiveId] = useState(CONVERSATIONS[0].id)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [isLoading, setIsLoading] = useState(false)

  const [endpoints, setEndpoints] = useState<Endpoint[]>([])
  const [activeEndpointId, setActiveEndpointId] = useState("")
  const [memoryConfig, setMemoryConfig] = useState<MemoryConfig>(DEFAULT_MEMORY_CONFIG)

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

      const savedMemory = localStorage.getItem("chat_memory_config")
      const parsedMemory = savedMemory ? JSON.parse(savedMemory) : {}
      const nextMemory: MemoryConfig = {
        enabled: memoryAvailable && Boolean(parsedMemory.enabled),
        userId: String(parsedMemory.userId ?? "").trim() || createMemoryUserId(),
      }
      setMemoryConfig(nextMemory)
      localStorage.setItem("chat_memory_config", JSON.stringify(nextMemory))
    } catch {
      setMemoryConfig({ enabled: false, userId: createMemoryUserId() })
    }
  }, [memoryAvailable])

  function handleEndpointsChange(eps: Endpoint[]) {
    setEndpoints(eps)
    try { localStorage.setItem("chat_endpoints", JSON.stringify(eps)) } catch { /* storage unavailable */ }
  }

  function handleActiveEndpointChange(id: string) {
    setActiveEndpointId(id)
    try { localStorage.setItem("chat_active_endpoint", id) } catch { /* storage unavailable */ }
  }

  function handleMemoryConfigChange(next: MemoryConfig) {
    setMemoryConfig(next)
    try { localStorage.setItem("chat_memory_config", JSON.stringify(next)) } catch { /* storage unavailable */ }
  }

  const activeEndpoint = endpoints.find(e => e.id === activeEndpointId)
  const memoryReady = Boolean(memoryAvailable && memoryConfig.enabled)
  const activeName = memoryReady ? "记忆笔友" : (activeEndpoint?.name ?? "笔友")

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

  async function handleSend(text: string) {
    const userMsg: Message = { id: `u-${Date.now()}`, role: "user", content: text, time: "此刻" }

    if (!activeEndpoint && !memoryReady) {
      setConversations(prev => prev.map(c => c.id === activeId ? {
        ...c, messages: [...c.messages, userMsg, { id: `e-${Date.now()}`, role: "assistant", content: "请先点击左下角齿轮图标，添加一个 API 端点。", time: "此刻", isError: true }]
      } : c))
      return
    }

    const msgId = `a-${Date.now()}`
    setConversations(prev => prev.map(c => c.id === activeId ? {
      ...c, messages: [...c.messages, userMsg, { id: msgId, role: "assistant", content: "", thinking: "", time: "此刻" }]
    } : c))

    setIsLoading(true)
    try {
      const history = [...active.messages, userMsg].map(m => ({ role: m.role, content: m.content }))
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          protocol: activeEndpoint?.protocol,
          baseUrl: activeEndpoint?.baseUrl,
          apiKey: activeEndpoint?.apiKey,
          model: activeEndpoint?.model,
          messages: history,
          memory: memoryReady ? memoryConfig : undefined,
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
        const parts = buf.split("\n\n")
        buf = parts.pop() ?? ""

        for (const part of parts) {
          const line = part.trim()
          if (!line || line === "data: [DONE]") continue
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6))
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

  function handleNew() {
    const id = `c-${Date.now()}`
    setConversations(prev => [{ id, title: "未命名的篇章", excerpt: "一页尚待书写的空白……", date: "今日", messages: [] }, ...prev])
    setActiveId(id)
    setDrawerOpen(false)
  }

  const sidebarProps = {
    conversations, activeId,
    onSelect: (id: string) => { setActiveId(id); setDrawerOpen(false) },
    onNew: handleNew,
    endpoints, activeEndpointId,
    onEndpointsChange: handleEndpointsChange,
    onActiveEndpointChange: handleActiveEndpointChange,
    memoryConfig,
    memoryAvailable,
    onMemoryConfigChange: handleMemoryConfigChange,
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
          memoryEnabled={memoryReady}
          mobile={mobile}
        />
      </main>
    )
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
      <span className="text-3xl text-primary">❦</span>
      <h2 className="mt-6 font-heading text-3xl tracking-wide text-foreground text-balance">空白的一页，正等你落墨</h2>
      <p className="mt-4 text-[15px] italic leading-[2] tracking-wide text-muted-foreground text-pretty">
        无需匆忙，也无需修饰。<br />
        把心里的念头，原原本本地写下来，<br />
        {endpointName ?? "笔友"} 会以同样的从容，与你慢慢对谈。
      </p>
    </div>
  )
}
