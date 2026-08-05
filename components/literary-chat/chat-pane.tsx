"use client"

import { useCallback, useEffect, useLayoutEffect, useState, type ComponentProps, type RefObject } from "react"
import { ArrowDown, PanelLeft } from "lucide-react"
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

export function ChatPane({ mobile, sidebarCollapsed, active, scrollRef, onOpenSidebar, onToggleSidebar, messageProps, inputProps }: ChatPaneProps) {
  useConversationBottomAnchor(active?.id, active?.messages.length ?? 0, scrollRef)
  const { showScrollButton, scrollToBottom } = useScrollToBottomControl(active?.id, scrollRef)
  const hasMessages = Boolean(active && active.messages.length > 0)

  return (
    <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
      <div className={cn("pointer-events-none absolute left-0 top-0 z-20", mobile ? "pl-3 pt-[max(0.65rem,env(safe-area-inset-top))]" : "pl-4 pt-4")}>
        <button onClick={mobile ? onOpenSidebar : onToggleSidebar} className="fluid-press fluid-icon-press pointer-events-auto flex size-11 items-center justify-center rounded-full border border-border/70 bg-background text-muted-foreground shadow-[0_2px_8px_rgba(8,8,8,0.07)] hover:bg-secondary hover:text-foreground dark:border-white/10 dark:bg-[#1D1D1D]" aria-label={mobile ? "打开对话列表" : sidebarCollapsed ? "展开侧栏" : "收起侧栏"}><PanelLeft className="size-5" /></button>
      </div>
      <div ref={scrollRef} style={{ overflowAnchor: "none" }} className={cn("fluid-scroll min-h-0 min-w-0 flex-1 overflow-x-clip overflow-y-auto bg-background font-sans", mobile ? "pt-[max(0.5rem,env(safe-area-inset-top))]" : "pt-2")}>
        {hasMessages ? <MessageList conversation={active!} {...messageProps} /> : <div className="mx-auto flex h-full max-w-[40rem] flex-col items-center justify-center px-8 text-center"><p className="text-[14px] text-muted-foreground/60">说点什么开始对谈</p></div>}
      </div>
      <div className="relative z-20 shrink-0">
        {hasMessages && showScrollButton && (
          <button
            type="button"
            onClick={scrollToBottom}
            className="fluid-press fluid-icon-press absolute left-1/2 top-0 z-30 flex size-11 -translate-x-1/2 -translate-y-[calc(100%+0.55rem)] items-center justify-center rounded-full border border-border bg-card text-foreground shadow-[0_7px_22px_rgba(20,18,15,0.18)] hover:bg-secondary dark:border-white/14 dark:bg-[#2B2B2A] dark:text-white dark:shadow-[0_8px_24px_rgba(0,0,0,0.42)]"
            aria-label="滚动到最新消息"
          >
            <ArrowDown className="size-5" strokeWidth={2} />
          </button>
        )}
        <ChatInput {...inputProps} mobile={mobile} />
      </div>
    </main>
  )
}

function jumpToAbsoluteBottom(element: HTMLDivElement) {
  element.scrollTop = element.scrollHeight
}

function useScrollToBottomControl(conversationId: string | undefined, scrollRef: RefObject<HTMLDivElement | null>) {
  const [showScrollButton, setShowScrollButton] = useState(false)

  const updateScrollState = useCallback(() => {
    const element = scrollRef.current
    if (!element || !conversationId) {
      setShowScrollButton(false)
      return
    }
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight
    setShowScrollButton(distanceFromBottom > 24)
  }, [conversationId, scrollRef])

  useEffect(() => {
    const element = scrollRef.current
    if (!element || !conversationId) {
      setShowScrollButton(false)
      return
    }

    let frame = 0
    const scheduleUpdate = () => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(updateScrollState)
    }
    const handleLoad = () => scheduleUpdate()
    element.addEventListener("scroll", scheduleUpdate, { passive: true })
    element.addEventListener("load", handleLoad, true)
    const resizeObserver = new ResizeObserver(scheduleUpdate)
    resizeObserver.observe(element)
    const content = element.firstElementChild
    if (content) resizeObserver.observe(content)
    const mutationObserver = new MutationObserver(scheduleUpdate)
    mutationObserver.observe(element, { childList: true, subtree: true, characterData: true })
    scheduleUpdate()

    return () => {
      window.cancelAnimationFrame(frame)
      element.removeEventListener("scroll", scheduleUpdate)
      element.removeEventListener("load", handleLoad, true)
      resizeObserver.disconnect()
      mutationObserver.disconnect()
    }
  }, [conversationId, scrollRef, updateScrollState])

  const scrollToBottom = useCallback(() => {
    const element = scrollRef.current
    if (!element) return
    setShowScrollButton(false)
    jumpToAbsoluteBottom(element)
    window.requestAnimationFrame(() => {
      jumpToAbsoluteBottom(element)
      window.requestAnimationFrame(() => jumpToAbsoluteBottom(element))
    })
  }, [scrollRef])

  return { showScrollButton, scrollToBottom }
}

function useConversationBottomAnchor(conversationId: string | undefined, messageCount: number, scrollRef: RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element || !conversationId) return

    let stopped = false
    let frame = 0
    const pinToBottom = () => {
      if (!stopped) jumpToAbsoluteBottom(element)
    }
    const schedulePin = () => {
      if (stopped) return
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        pinToBottom()
        frame = window.requestAnimationFrame(pinToBottom)
      })
    }
    const stopPinning = () => {
      stopped = true
      window.cancelAnimationFrame(frame)
    }
    const handleLoad = () => schedulePin()

    pinToBottom()
    schedulePin()

    element.addEventListener("pointerdown", stopPinning, { passive: true })
    element.addEventListener("touchstart", stopPinning, { passive: true })
    element.addEventListener("wheel", stopPinning, { passive: true })
    element.addEventListener("load", handleLoad, true)

    const resizeObserver = new ResizeObserver(schedulePin)
    resizeObserver.observe(element)
    const content = element.firstElementChild
    if (content) resizeObserver.observe(content)

    const mutationObserver = new MutationObserver(schedulePin)
    mutationObserver.observe(element, { childList: true, subtree: true, characterData: true })

    const retryTimers = [50, 150, 400, 900, 1_600, 3_000].map(delay => window.setTimeout(schedulePin, delay))
    void document.fonts?.ready.then(schedulePin)

    return () => {
      stopped = true
      window.cancelAnimationFrame(frame)
      retryTimers.forEach(timer => window.clearTimeout(timer))
      element.removeEventListener("pointerdown", stopPinning)
      element.removeEventListener("touchstart", stopPinning)
      element.removeEventListener("wheel", stopPinning)
      element.removeEventListener("load", handleLoad, true)
      resizeObserver.disconnect()
      mutationObserver.disconnect()
    }
  }, [conversationId, messageCount, scrollRef])
}
