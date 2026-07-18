"use client"

import type { ComponentProps, RefObject } from "react"
import { ChevronDown, Folder, PanelLeft } from "lucide-react"
import { motion, useReducedMotion } from "motion/react"
import type { Conversation } from "@/lib/chat-data"
import type { Project } from "@/lib/project-data"
import { ChatInput } from "@/components/chat-input"
import { ConversationRename } from "@/components/conversation-menu"
import { MessageList } from "@/components/message-list"
import { cn } from "@/lib/utils"
import { UI_SPRING, transitionFor } from "@/components/motion/fluid"

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
      <ChatHeader mobile={mobile} active={active} activeProject={activeProject} menuAnchor={menuAnchor} renaming={renaming} onOpenSidebar={onOpenSidebar} onToggleSidebar={onToggleSidebar} onMenuAnchorChange={onMenuAnchorChange} onRenamingChange={onRenamingChange} onRename={onRename} />

      <div
        ref={scrollRef}
        className="fluid-scroll min-h-0 min-w-0 flex-1 overflow-x-clip overflow-y-auto bg-background font-serif"
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

function ChatHeader({ mobile, active, activeProject, menuAnchor, renaming, onOpenSidebar, onToggleSidebar, onMenuAnchorChange, onRenamingChange, onRename }: {
  mobile: boolean
  active?: Conversation
  activeProject: Project | null
  menuAnchor: { bottom: number; left: number } | null
  renaming: boolean
  onOpenSidebar: () => void
  onToggleSidebar: () => void
  onMenuAnchorChange: (anchor: { bottom: number; left: number } | null) => void
  onRenamingChange: (renaming: boolean) => void
  onRename: (id: string, title: string) => void
}) {
  const reducedMotion = useReducedMotion()
  return (
    <header className={cn("fluid-material z-10 flex shrink-0 items-center gap-2", mobile ? "px-4 pb-2 pt-[max(0.75rem,env(safe-area-inset-top))]" : "px-8 py-4")}>
      <button onClick={mobile ? onOpenSidebar : onToggleSidebar} className="fluid-press fluid-icon-press flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground" aria-label={mobile ? "打开对话列表" : "收起侧栏"}><PanelLeft className="size-5" /></button>
      {renaming && active ? <ConversationRename value={active.title} onCommit={title => { if (title.trim()) onRename(active.id, title.trim()); onRenamingChange(false) }} onCancel={() => onRenamingChange(false)} className="min-w-0 flex-1 rounded-lg bg-secondary/60 px-3 py-1.5 text-sm outline-none focus:bg-secondary/80" />
        : active ? <ConversationTitle active={active} activeProject={activeProject} menuAnchor={menuAnchor} reducedMotion={reducedMotion} onMenuAnchorChange={onMenuAnchorChange} />
        : <span className="flex-1" />}
    </header>
  )
}

function ConversationTitle({ active, activeProject, menuAnchor, reducedMotion, onMenuAnchorChange }: {
  active: Conversation
  activeProject: Project | null
  menuAnchor: { bottom: number; left: number } | null
  reducedMotion: boolean | null
  onMenuAnchorChange: (anchor: { bottom: number; left: number } | null) => void
}) {
  return (
    <button onClick={event => {
      if (active.draft) return
      if (menuAnchor) return onMenuAnchorChange(null)
      const bounds = event.currentTarget.getBoundingClientRect()
      onMenuAnchorChange({ bottom: bounds.bottom, left: bounds.left })
    }} className={cn("fluid-press flex min-h-11 min-w-0 flex-1 items-center gap-1.5 rounded-full px-3 py-1 text-left", !active.draft && "hover:bg-secondary/50")}>
      {activeProject && <><Folder className="size-3.5 shrink-0 text-primary/70" /><span className="max-w-[6rem] shrink-0 truncate text-sm font-medium text-foreground/90">{activeProject.name.slice(0, 10)}</span><span className="shrink-0 text-muted-foreground/40">/</span></>}
      <span className="min-w-0 truncate text-sm italic text-muted-foreground">{active.title}</span>
      {!active.draft && <motion.span initial={false} animate={{ rotate: menuAnchor ? 180 : 0 }} transition={transitionFor(reducedMotion, UI_SPRING)} className="shrink-0 text-muted-foreground/60"><ChevronDown className="size-4" /></motion.span>}
    </button>
  )
}
