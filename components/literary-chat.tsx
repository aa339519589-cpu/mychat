"use client"

import { useMemo, useRef, useState, useEffect } from "react"
import {
  CONVERSATIONS,
  MODELS,
  type Conversation,
  type Message,
} from "@/lib/chat-data"
import { ConversationSidebar } from "@/components/conversation-sidebar"
import { MessageList } from "@/components/message-list"
import { ChatInput } from "@/components/chat-input"
import { cn } from "@/lib/utils"
import { PanelLeft, X } from "lucide-react"

const REPLIES = [
  "你的话语我已收下。让我慢慢想一想——\n\n有些念头如同晨雾，需静待片刻才肯散开。请容我以从容的笔触回应你。",
  "这是一个值得细品的问题。\n\n或许答案并不在远方，而在你提问时心底已隐约浮现的那个轮廓里。",
  "我懂你的意思了。\n\n文字之间，常有未尽之言。我们不妨就停在这里，让余味自行生长。",
]

export function LiteraryChat() {
  const [conversations, setConversations] =
    useState<Conversation[]>(CONVERSATIONS)
  const [activeId, setActiveId] = useState(CONVERSATIONS[0].id)
  // 移动端抽屉开合
  const [drawerOpen, setDrawerOpen] = useState(false)
  // 桌面端侧栏展开/收起
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  const activeModel = MODELS[0]
  const active = useMemo(
    () => conversations.find((c) => c.id === activeId)!,
    [conversations, activeId],
  )

  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    })
  }, [active.messages.length, activeId])

  function handleSend(text: string) {
    const userMsg: Message = {
      id: `u-${Date.now()}`,
      role: "user",
      content: text,
      time: "此刻",
    }
    const reply = REPLIES[Math.floor(Math.random() * REPLIES.length)]
    const botMsg: Message = {
      id: `a-${Date.now()}`,
      role: "assistant",
      content: reply,
      time: "此刻",
    }
    setConversations((prev) =>
      prev.map((c) =>
        c.id === activeId
          ? { ...c, messages: [...c.messages, userMsg, botMsg] }
          : c,
      ),
    )
  }

  function handleNew() {
    const id = `c-${Date.now()}`
    const fresh: Conversation = {
      id,
      title: "未命名的篇章",
      excerpt: "一页尚待书写的空白……",
      date: "今日",
      messages: [],
    }
    setConversations((prev) => [fresh, ...prev])
    setActiveId(id)
    setDrawerOpen(false)
  }

  function selectConversation(id: string) {
    setActiveId(id)
    setDrawerOpen(false)
  }

  return (
    <div className="flex h-screen overflow-hidden bg-background paper-grain p-3 md:p-4">
      {/* 侧栏 - 桌面：可展开/收起 */}
      <div
        className={cn(
          "hidden shrink-0 overflow-hidden transition-[width] duration-300 ease-in-out md:block",
          sidebarCollapsed ? "w-0" : "w-[20rem]",
        )}
      >
        <div className="h-full w-[20rem] overflow-hidden border-r border-border/50 bg-sidebar/40">
          <ConversationSidebar
            conversations={conversations}
            activeId={activeId}
            onSelect={selectConversation}
            onNew={handleNew}
          />
        </div>
      </div>

      {/* 侧栏 - 移动抽屉 */}
      <div
        className={cn(
          "fixed inset-0 z-40 md:hidden",
          drawerOpen ? "pointer-events-auto" : "pointer-events-none",
        )}
      >
        <div
          onClick={() => setDrawerOpen(false)}
          className={cn(
            "absolute inset-0 bg-foreground/30 transition-opacity",
            drawerOpen ? "opacity-100" : "opacity-0",
          )}
        />
        <div
          className={cn(
            "absolute left-0 top-0 h-full w-[18rem] rounded-r-3xl border-r border-border bg-sidebar shadow-xl transition-transform",
            drawerOpen ? "translate-x-0" : "-translate-x-full",
          )}
        >
          <ConversationSidebar
            conversations={conversations}
            activeId={activeId}
            onSelect={selectConversation}
            onNew={handleNew}
          />
        </div>
        {drawerOpen && (
          <button
            onClick={() => setDrawerOpen(false)}
            className="absolute right-4 top-4 z-50 rounded-full bg-card p-2 text-foreground shadow"
            aria-label="关闭对话历史"
          >
            <X className="size-5" aria-hidden />
          </button>
        )}
      </div>

      {/* 主区 */}
      <div className="ml-0 flex min-w-0 flex-1 flex-col overflow-hidden md:ml-2">
        {/* 顶栏 */}
        <header className="flex items-center gap-3 px-5 py-4 md:px-8">
          {/* 桌面收起/展开 */}
          <button
            onClick={() => setSidebarCollapsed((v) => !v)}
            className="hidden rounded-full p-2 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground md:inline-flex"
            aria-label={sidebarCollapsed ? "展开对话历史" : "收起对话历史"}
            aria-pressed={!sidebarCollapsed}
          >
            <PanelLeft className="size-5" aria-hidden />
          </button>
          {/* 移动端打开抽屉 */}
          <button
            onClick={() => setDrawerOpen(true)}
            className="rounded-full p-2 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground md:hidden"
            aria-label="打开对话历史"
          >
            <PanelLeft className="size-5" aria-hidden />
          </button>
          <span className="text-sm italic tracking-wider text-muted-foreground">
            {active.title}
          </span>
        </header>

        {/* 消息卷轴 */}
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
          {active.messages.length > 0 ? (
            <MessageList conversation={active} model={activeModel} />
          ) : (
            <EmptyState modelName={activeModel.name} />
          )}
        </div>

        {/* 输入 */}
        <div>
          <ChatInput onSend={handleSend} modelName={activeModel.name} />
        </div>
      </div>
    </div>
  )
}

function EmptyState({ modelName }: { modelName: string }) {
  return (
    <div className="mx-auto flex h-full max-w-[40rem] flex-col items-center justify-center px-8 text-center">
      <span className="text-3xl text-primary">❦</span>
      <h2 className="mt-6 font-heading text-3xl tracking-wide text-foreground text-balance">
        空白的一页，正等你落墨
      </h2>
      <p className="mt-4 text-[15px] italic leading-[2] tracking-wide text-muted-foreground text-pretty">
        无需匆忙，也无需修饰。
        <br />
        把心里的念头，原原本本地写下来，
        <br />
        {modelName} 会以同样的从容，与你慢慢对谈。
      </p>
    </div>
  )
}
