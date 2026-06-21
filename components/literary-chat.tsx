"use client"

import { useMemo, useRef, useState, useEffect } from "react"
import { CONVERSATIONS, DEFAULT_MEMORY_CONFIG, type Conversation, type Message, type Endpoint, type MemoryConfig } from "@/lib/chat-data"
import { ConversationSidebar } from "@/components/conversation-sidebar"
import { MessageList } from "@/components/message-list"
import { ChatInput } from "@/components/chat-input"
import { cn } from "@/lib/utils"
import { PanelLeft, X } from "lucide-react"

export function LiteraryChat() {
  const [conversations, setConversations] = useState<Conversation[]>(CONVERSATIONS)
  const [activeId, setActiveId] = useState(CONVERSATIONS[0].id)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [isLoading, setIsLoading] = useState(false)

  const [endpoints, setEndpoints] = useState<Endpoint[]>([])
  const [activeEndpointId, setActiveEndpointId] = useState("")
  const [memoryConfig, setMemoryConfig] = useState<MemoryConfig>(DEFAULT_MEMORY_CONFIG)

  useEffect(() => {
    const saved = localStorage.getItem("chat_endpoints")
    if (saved) setEndpoints(JSON.parse(saved))
    const savedActive = localStorage.getItem("chat_active_endpoint")
    if (savedActive) setActiveEndpointId(savedActive)
    const savedMemory = localStorage.getItem("chat_memory_config")
    if (savedMemory) setMemoryConfig({ ...DEFAULT_MEMORY_CONFIG, ...JSON.parse(savedMemory) })
  }, [])

  function handleEndpointsChange(eps: Endpoint[]) {
    setEndpoints(eps)
    localStorage.setItem("chat_endpoints", JSON.stringify(eps))
  }

  function handleActiveEndpointChange(id: string) {
    setActiveEndpointId(id)
    localStorage.setItem("chat_active_endpoint", id)
  }

  function handleMemoryConfigChange(next: MemoryConfig) {
    setMemoryConfig(next)
    localStorage.setItem("chat_memory_config", JSON.stringify(next))
  }

  const activeEndpoint = endpoints.find(e => e.id === activeEndpointId)
  const memoryReady = Boolean(memoryConfig.enabled && memoryConfig.baseUrl.trim())
  const activeName = memoryReady ? "记忆笔友" : (activeEndpoint?.name ?? "笔友")

  const active = useMemo(
    () => conversations.find(c => c.id === activeId)!,
    [conversations, activeId],
  )

  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
  }, [active?.messages?.length, activeId])

  async function handleSend(text: string) {
    const userMsg: Message = { id: `u-${Date.now()}`, role: "user", content: text, time: "此刻" }

    if (memoryConfig.enabled && !memoryReady) {
      setConversations(prev => prev.map(c => c.id === activeId ? {
        ...c, messages: [...c.messages, userMsg, { id: `e-${Date.now()}`, role: "assistant", content: "请先在设置里填写记忆系统的后端地址。", time: "此刻", isError: true }]
      } : c))
      return
    }

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
    onMemoryConfigChange: handleMemoryConfigChange,
  }

  return (
    <div className="flex h-screen overflow-hidden bg-background paper-grain p-3 md:p-4">
      {/* 侧栏 - 桌面 */}
      <div className={cn("hidden shrink-0 overflow-hidden transition-[width] duration-300 ease-in-out md:block", sidebarCollapsed ? "w-0" : "w-[20rem]")}>
        <div className="h-full w-[20rem] overflow-hidden border-r border-border/50 bg-sidebar/40">
          <ConversationSidebar {...sidebarProps} />
        </div>
      </div>

      {/* 侧栏 - 移动抽屉 */}
      <div className={cn("fixed inset-0 z-40 md:hidden", drawerOpen ? "pointer-events-auto" : "pointer-events-none")}>
        <div onClick={() => setDrawerOpen(false)} className={cn("absolute inset-0 bg-foreground/30 transition-opacity", drawerOpen ? "opacity-100" : "opacity-0")} />
        <div className={cn("absolute left-0 top-0 h-full w-[18rem] rounded-r-3xl border-r border-border bg-sidebar shadow-xl transition-transform", drawerOpen ? "translate-x-0" : "-translate-x-full")}>
          <ConversationSidebar {...sidebarProps} />
        </div>
        {drawerOpen && (
          <button onClick={() => setDrawerOpen(false)} className="absolute right-4 top-4 z-50 rounded-full bg-card p-2 text-foreground shadow">
            <X className="size-5" />
          </button>
        )}
      </div>

      {/* 主区 */}
      <div className="ml-0 flex min-w-0 flex-1 flex-col overflow-hidden md:ml-2">
        <header className="flex items-center gap-3 px-5 py-4 md:px-8">
          <button onClick={() => setSidebarCollapsed(v => !v)} className="hidden rounded-full p-2 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground md:inline-flex">
            <PanelLeft className="size-5" />
          </button>
          <button onClick={() => setDrawerOpen(true)} className="rounded-full p-2 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground md:hidden">
            <PanelLeft className="size-5" />
          </button>
          <span className="flex-1 text-sm italic tracking-wider text-muted-foreground">{active?.title}</span>
        </header>

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
          {active?.messages?.length > 0 ? (
            <MessageList conversation={active} endpointName={activeName} />
          ) : (
            <EmptyState endpointName={activeName} />
          )}
          {isLoading && (
            <div className="mx-auto max-w-[44rem] px-10 pb-4 text-sm italic text-muted-foreground animate-pulse">
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
        />
      </div>
    </div>
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
