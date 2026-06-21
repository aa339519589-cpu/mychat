"use client"

import type { Conversation } from "@/lib/chat-data"
import { cn } from "@/lib/utils"
import { Feather, Plus } from "lucide-react"

export function ConversationSidebar({
  conversations,
  activeId,
  onSelect,
  onNew,
}: {
  conversations: Conversation[]
  activeId: string
  onSelect: (id: string) => void
  onNew: () => void
}) {
  return (
    <aside className="flex h-full w-full flex-col bg-sidebar text-sidebar-foreground">
      {/* 刊头 */}
      <div className="px-7 pb-6 pt-8">
        <div className="flex items-center gap-2.5">
          <Feather className="size-5 text-sidebar-primary" aria-hidden />
          <h1 className="font-heading text-2xl tracking-wide text-sidebar-foreground">
            笺
          </h1>
        </div>
        <p className="mt-2 text-xs leading-relaxed tracking-wider text-muted-foreground">
          文字对谈集 · 卷一
        </p>
      </div>

      <div className="mx-7 mb-5 border-t border-sidebar-border" aria-hidden />

      <button
        onClick={onNew}
        className="mx-5 mb-4 flex items-center gap-2 rounded-sm px-2 py-2 text-sm tracking-wide text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      >
        <Plus className="size-4" aria-hidden />
        起一篇新的对谈
      </button>

      {/* 目录 */}
      <nav
        aria-label="对话历史"
        className="flex-1 space-y-1 overflow-y-auto px-3 pb-8"
      >
        {conversations.map((c) => {
          const isActive = c.id === activeId
          return (
            <button
              key={c.id}
              onClick={() => onSelect(c.id)}
              aria-current={isActive ? "true" : undefined}
              className={cn(
                "group block w-full rounded-sm px-4 py-3 text-left transition-colors",
                isActive
                  ? "bg-sidebar-accent"
                  : "hover:bg-sidebar-accent/60",
              )}
            >
              <div className="flex items-baseline justify-between gap-3">
                <span
                  className={cn(
                    "font-heading text-[15px] leading-snug tracking-wide",
                    isActive
                      ? "text-sidebar-primary"
                      : "text-sidebar-foreground",
                  )}
                >
                  {c.title}
                </span>
                <span className="shrink-0 text-[11px] tracking-wider text-muted-foreground">
                  {c.date}
                </span>
              </div>
              <p className="mt-1.5 line-clamp-2 text-[13px] leading-relaxed text-muted-foreground">
                {c.excerpt}
              </p>
            </button>
          )
        })}
      </nav>

      <div className="mx-7 border-t border-sidebar-border" aria-hidden />
      <p className="px-7 py-5 text-[11px] italic leading-relaxed tracking-wider text-muted-foreground">
        「文字是缓慢的，正因如此，才值得珍藏。」
      </p>
    </aside>
  )
}
