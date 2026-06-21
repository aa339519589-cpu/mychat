"use client"

import { useMemo, useRef, useState, useEffect } from "react"
import {
  CONVERSATIONS,
  MODELS,
  type Conversation,
  type Message,
  type ModelId,
} from "@/lib/chat-data"
import { ModelSwitcher } from "@/components/model-switcher"
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
  const [model, setModel] = useState<ModelId>("claude")
  const [conversations, setConversations] =
    useState<Conversation[]>(CONVERSATIONS)
  const [activeId, setActiveId] = useState(CONVERSATIONS[0].id)
  const [sidebarOpen, setSidebarOpen] = useState(false)

  const activeModel = MODELS.find((m) => m.id === model)!
  const active = useMemo(
    () => conversations.find((c) => c.id === activeId)!,
    [conversations, activeId],
  )

  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" })
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
    setSidebarOpen(false)
  }

  function selectConversation(id: string) {
    setActiveId(id)
    setSidebarOpen(false)
  }

  return (
    <div className="flex h-screen overflow-hidden bg-background paper-grain">
      {/* 侧栏 - 桌面 */}
      <div className="hidden w-[20rem] shrink-0 border-r border-border md:block">
        <ConversationSidebar
          conversations={conversations}
          activeId={activeId}
          onSelect={selectConversation}
          onNew={handleNew}
        />
      </div>

      {/* 侧栏 - 移动抽屉 */}
      <div
        className={cn(
          "fixed inset-0 z-40 md:hidden",
          sidebarOpen ? "pointer-events-auto" : "pointer-events-none",
        )}
      >
        <div
          onClick={() => setSidebarOpen(false)}
          className={cn(
            "absolute inset-0 bg-foreground/30 transition-opacity",
            sidebarOpen ? "opacity-100" : "opacity-0",
          )}
        />
        <div
          className={cn(
            "absolute left-0 top-0 h-full w-[18rem] border-r border-border shadow-xl transition-transform",
            sidebarOpen ? "translate-x-0" : "-translate-x-full",
          )}
        >
          <ConversationSidebar
            conversations={conversations}
            activeId={activeId}
            onSelect={selectConversation}
            onNew={handleNew}
          />
        </div>
      </div>

      {/* 主区 */}
      <div className="flex min-w-0 flex-1 flex-col page-vignette">
        {/* 顶栏 */}
        <header className="flex items-center justify-between gap-4 border-b border-border px-5 py-4 md:px-8">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setSidebarOpen(true)}
              className="rounded-sm p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground md:hidden"
              aria-label="打开对话历史"
            >
              <PanelLeft className="size-5" aria-hidden />
            </button>
            <span className="hidden text-sm italic tracking-wider text-muted-foreground sm:inline">
              今日由谁执笔——
            </span>
          </div>
          <ModelSwitcher active={model} onChange={setModel} />
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
        <div className="border-t border-border bg-background/60">
          <ChatInput onSend={handleSend} modelName={activeModel.name} />
        </div>
      </div>

      {/* 移动端关闭按钮浮层（无障碍冗余）*/}
      {sidebarOpen && (
        <button
          onClick={() => setSidebarOpen(false)}
          className="fixed right-4 top-4 z-50 rounded-sm bg-card p-2 text-foreground shadow md:hidden"
          aria-label="关闭对话历史"
        >
          <X className="size-5" aria-hidden />
        </button>
      )}
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
