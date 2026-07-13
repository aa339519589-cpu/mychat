"use client"

import type { ComponentProps, RefObject } from "react"
import { ChevronDown, Folder, PanelLeft } from "lucide-react"
import type { Conversation } from "@/lib/chat-data"
import type { Project } from "@/lib/project-data"
import { ChatInput } from "@/components/chat-input"
import { ConversationRename } from "@/components/conversation-menu"
import { MessageList } from "@/components/message-list"
import { cn } from "@/lib/utils"

type ChatPaneProps = {
  mobile: boolean
  active?: Conversation
  activeProject: Project | null
  scrollRef: RefObject<HTMLDivElement | null>
  menuAnchor: { bottom: number; left: number } | null
  renaming: boolean
  onOpenSidebar: () => void
  onToggleSidebar: () => void
  onMenuAnchorChange: (anchor: { bottom: number; left: number } | null) => void
  onRenamingChange: (renaming: boolean) => void
  onRename: (id: string, title: string) => void
  messageProps: Omit<ComponentProps<typeof MessageList>, "conversation">
  inputProps: Omit<ComponentProps<typeof ChatInput>, "mobile">
}

export function ChatPane({
  mobile,
  active,
  activeProject,
  scrollRef,
  menuAnchor,
  renaming,
  onOpenSidebar,
  onToggleSidebar,
  onMenuAnchorChange,
  onRenamingChange,
  onRename,
  messageProps,
  inputProps,
}: ChatPaneProps) {
  return (
    <main className={cn("flex min-w-0 flex-1 flex-col overflow-hidden", !mobile && "ml-0")}>
      <header className={cn(
        "z-10 flex shrink-0 items-center gap-3 bg-background/90 backdrop-blur-sm",
        mobile ? "px-4 pb-2 pt-[max(0.75rem,env(safe-area-inset-top))]" : "px-8 py-4",
      )}>
        <button
          onClick={mobile ? onOpenSidebar : onToggleSidebar}
          className="inline-flex shrink-0 rounded-full p-2 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          aria-label={mobile ? "打开对话列表" : "收起侧栏"}
        >
          <PanelLeft className="size-5" />
        </button>

        {renaming && active ? (
          <ConversationRename
            value={active.title}
            onCommit={title => {
              if (title.trim()) onRename(active.id, title.trim())
              onRenamingChange(false)
            }}
            onCancel={() => onRenamingChange(false)}
            className="min-w-0 flex-1 rounded-lg bg-secondary/60 px-3 py-1.5 text-sm outline-none focus:bg-secondary/80"
          />
        ) : active ? (
          <button
            onClick={event => {
              if (active.draft) return
              if (menuAnchor) {
                onMenuAnchorChange(null)
                return
              }
              const bounds = event.currentTarget.getBoundingClientRect()
              onMenuAnchorChange({ bottom: bounds.bottom, left: bounds.left })
            }}
            className={cn(
              "flex min-w-0 flex-1 items-center gap-1.5 rounded-full px-2 py-1 text-left transition-colors",
              !active.draft && "hover:bg-secondary/50",
            )}
          >
            {activeProject && (
              <>
                <Folder className="size-3.5 shrink-0 text-primary/70" />
                <span className="max-w-[6rem] shrink-0 truncate text-sm font-medium text-foreground/90">
                  {activeProject.name.slice(0, 10)}
                </span>
                <span className="shrink-0 text-muted-foreground/40">/</span>
              </>
            )}
            <span className="min-w-0 truncate text-sm italic text-muted-foreground">{active.title}</span>
            {!active.draft && (
              <ChevronDown className={cn(
                "size-4 shrink-0 text-muted-foreground/60 transition-transform",
                menuAnchor && "rotate-180",
              )} />
            )}
          </button>
        ) : (
          <span className="flex-1" />
        )}
      </header>

      <div
        ref={scrollRef}
        className="min-h-0 min-w-0 flex-1 overflow-x-clip overflow-y-auto overscroll-contain bg-background font-serif"
      >
        {active && active.messages.length > 0 ? (
          <MessageList conversation={active} {...messageProps} />
        ) : (
          <div className="mx-auto flex h-full max-w-[40rem] flex-col items-center justify-center px-8 text-center">
            <p className="text-[14px] italic text-muted-foreground/60">说点什么开始对谈</p>
          </div>
        )}
      </div>

      <ChatInput {...inputProps} mobile={mobile} />
    </main>
  )
}
