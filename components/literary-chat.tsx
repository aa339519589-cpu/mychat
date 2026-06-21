"use client"

import { useMemo, useRef, useState, useEffect } from "react"
import {
  CONVERSATIONS,
  MODELS,
  type Conversation,
  type Message,
  type ModelId,
} from "@/lib/chat-data"
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

  const [apiKeys, setApiKeys] = useState<Record<string, string>>({ claude: "", gpt: "", gemini: "", deepseek: "" })
  const [selectedModel, setSelectedModel] = useState<ModelId>("claude")

  useEffect(() => {
    const saved = localStorage.getItem("chat_keys")
    if (saved) setApiKeys(JSON.parse(saved))
    const savedModel = localStorage.getItem("chat_model") as ModelId
    if (savedModel) setSelectedModel(savedModel)
  }, [])

  function handleSaveKey(model: string, key: string) {
    const next = { ...apiKeys, [model]: key }
    setApiKeys(next)
    localStorage.setItem("chat_keys", JSON.stringify(next))
  }

  function handleModelChange(model: ModelId) {
    setSelectedModel(model)
    localStorage.setItem("chat_model", model)
  }

  const activeModel = MODELS.find((m) => m.id === selectedModel) ?? MODELS[0]
  const active = useMemo(
    () => conversations.find((c) => c.id === activeId)!,
    [conversations, activeId],
  )

  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" })
  }, [active.messages.length, activeId, isLoading])

  async function handleSend(text: string) {
    const userMsg: Message = { id: `u-${Date.now()}`, role: "user", content: text, time: "此刻" }

    setConversations((prev) =>
      prev.map((c) => c.id === activeId ? { ...c, messages: [...c.messages, userMsg] } : c)
    )

    const apiKey = apiKeys[selectedModel]
    if (!apiKey) {
      const errMsg: Message = {
        id: `e-${Date.now()}`,
        role: "assistant",
        content: "⚠️ 请先点击左下角齿轮图标，填写对应模型的 API Key。",
        time: "此刻",
      }
      setConversations((prev) =>
        prev.map((c) => c.id === activeId ? { ...c, messages: [...c.messages, errMsg] } : c)
      )
      return
    }

    setIsLoading(true)
    try {
      const history = [...active.messages, userMsg].map((m) => ({
        role: m.role,
        content: m.content,
      }))

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: selectedModel, messages: history, apiKey }),
      })
      const data = await res.json()

      const botMsg: Message = {
        id: `a-${Date.now()}`,
        role: "assistant",
        content: data.error ? `⚠️ ${data.error}` : data.content,
        time: "此刻",
      }
      setConversations((prev) =>
        prev.map((c) => c.id === activeId ? { ...c, messages: [...c.messages, botMsg] } : c)
      )
    } finally {
      setIsLoading(false)
    }
  }

  function handleNew() {
    const id = `c-${Date.now()}`
    setConversations((prev) => [{
      id, title: "未命名的篇章", excerpt: "一页尚待书写的空白……", date: "今日", messages: [],
    }, ...prev])
    setActiveId(id)
    setDrawerOpen(false)
  }

  function selectConversation(id: string) {
    setActiveId(id)
    setDrawerOpen(false)
  }

  const sidebarProps = { conversations, activeId, onSelect: selectConversation, onNew: handleNew, apiKeys, selectedModel, onSaveKey: handleSaveKey, onModelChange: handleModelChange }

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
            <X className="size-5" aria-hidden />
          </button>
        )}
      </div>

      {/* 主区 */}
      <div className="ml-0 flex min-w-0 flex-1 flex-col overflow-hidden md:ml-2">
        <header className="flex items-center gap-3 px-5 py-4 md:px-8">
          <button onClick={() => setSidebarCollapsed((v) => !v)} className="hidden rounded-full p-2 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground md:inline-flex">
            <PanelLeft className="size-5" aria-hidden />
          </button>
          <button onClick={() => setDrawerOpen(true)} className="rounded-full p-2 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground md:hidden">
            <PanelLeft className="size-5" aria-hidden />
          </button>
          <span className="flex-1 text-sm italic tracking-wider text-muted-foreground">{active.title}</span>
          <span className="text-xs tracking-widest text-muted-foreground">{activeModel.name} · {activeModel.subtitle}</span>
        </header>

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
          {active.messages.length > 0 ? (
            <MessageList conversation={active} model={activeModel} />
          ) : (
            <EmptyState modelName={activeModel.name} />
          )}
          {isLoading && (
            <div className="mx-auto max-w-[44rem] px-10 pb-4 text-sm italic text-muted-foreground animate-pulse">
              {activeModel.name} 正在落笔……
            </div>
          )}
        </div>

        <ChatInput onSend={handleSend} modelName={activeModel.name} />
      </div>
    </div>
  )
}

function EmptyState({ modelName }: { modelName: string }) {
  return (
    <div className="mx-auto flex h-full max-w-[40rem] flex-col items-center justify-center px-8 text-center">
      <span className="text-3xl text-primary">❦</span>
      <h2 className="mt-6 font-heading text-3xl tracking-wide text-foreground text-balance">空白的一页，正等你落墨</h2>
      <p className="mt-4 text-[15px] italic leading-[2] tracking-wide text-muted-foreground text-pretty">
        无需匆忙，也无需修饰。<br />
        把心里的念头，原原本本地写下来，<br />
        {modelName} 会以同样的从容，与你慢慢对谈。
      </p>
    </div>
  )
}
