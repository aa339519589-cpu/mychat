"use client"

import { useLayoutEffect, type ComponentProps, type RefObject } from "react"
import { PanelLeft } from "lucide-react"
import type { Conversation } from "@/lib/chat-data"
import { ChatInput } from "@/components/chat-input"
import { MessageList } from "@/components/message-list"
import { cn } from "@/lib/utils"

type ChatPaneProps = {
  mobile: boolean
  sidebarCollapsed: boolean
  active?: Conversation
  scrollRef: RefObject<HTMLDivElement | null>
  onOpenSidebar: () => void
  onToggleSidebar: () => void
  messageProps: Omit<ComponentProps<typeof MessageList>, "conversation">
  inputProps: Omit<ComponentProps<typeof ChatInput>, "mobile">
}

export function ChatPane({
  mobile,
  sidebarCollapsed,
  active,
  scrollRef,
  onOpenSidebar,
  onToggleSidebar,
  messageProps,
  inputProps,
}: ChatPaneProps) {
  useConversationBottomAnchor(active?.id, scrollRef)

  return (
    <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
      <div className={cn("pointer-events-none absolute left-0 top-0 z-20", mobile ? "pl-3 pt-[max(0.75rem,env(safe-area-inset-top))]" : "pl-4 pt-4")}>
        <button
          onClick={mobile ? onOpenSidebar : onToggleSidebar}
          className="fluid-press fluid-icon-press pointer-events-auto flex size-11 items-center justify-center rounded-full text-muted-foreground/75 hover:bg-secondary/65 hover:text-foreground"
          aria-label={mobile ? "打开对话列表" : sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
        >
          <PanelLeft className="size-5" />
        </button>
      </div>

      <div
        ref={scrollRef}
        className={cn(
          "fluid-scroll min-h-0 min-w-0 flex-1 overflow-x-clip overflow-y-auto bg-background font-serif",
          mobile ? "pt-[calc(env(safe-area-inset-top)+3.75rem)]" : "pt-16",
        )}
      >
        {active && active.messages.length > 0 ? (
          <MessageList conversation={active} {...messageProps} />
        ) : (
          <div className="mx-auto flex h-full max-w-[40rem] flex-col items-center justify-center px-8 text-center">
            <p className="text-[14px] text-muted-foreground/60">说点什么开始对谈</p>
          </div>
        )}
      </div>

      <ChatInput {...inputProps} mobile={mobile} />
    </main>
  )
}

function useConversationBottomAnchor(
  conversationId: string | undefined,
  scrollRef: RefObject<HTMLDivElement | null>,
) {
  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element || !conversationId) return

    let stopped = false
    let secondFrame = 0
    const pinToBottom = () => {
      if (!stopped) element.scrollTop = element.scrollHeight
    }

    // The first scroll can run before cached/remote messages and fonts have
    // finished laying out. Pin again across the next frames and while the
    // newly opened conversation hydrates so reopening always lands at the end.
    pinToBottom()
    const firstFrame = window.requestAnimationFrame(() => {
      pinToBottom()
      secondFrame = window.requestAnimationFrame(pinToBottom)
    })
    const mutations = new MutationObserver(pinToBottom)
    mutations.observe(element, { childList: true, subtree: true, characterData: true })
    const timeout = window.setTimeout(() => mutations.disconnect(), 1_500)

    return () => {
      stopped = true
      window.cancelAnimationFrame(firstFrame)
      if (secondFrame) window.cancelAnimationFrame(secondFrame)
      window.clearTimeout(timeout)
      mutations.disconnect()
    }
  }, [conversationId, scrollRef])
}
