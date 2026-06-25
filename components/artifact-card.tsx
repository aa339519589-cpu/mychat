"use client"

import { cn } from "@/lib/utils"
import { Loader2, ChevronRight, LayoutTemplate } from "lucide-react"

// 对话流里的 artifact 入口卡片：点击在右侧面板打开
export function ArtifactCard({
  title, done, active, onClick,
}: {
  title: string
  done: boolean
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "group flex w-full items-center gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors animate-in fade-in duration-300",
        active
          ? "border-primary/50 bg-primary/5"
          : "border-border/60 bg-card/40 hover:border-border hover:bg-card/70",
      )}
    >
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        {done ? <LayoutTemplate className="size-4" /> : <Loader2 className="size-4 animate-spin" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">{title}</div>
        <div className="truncate text-xs text-muted-foreground">{done ? "点击查看 · 可下载" : "生成中……"}</div>
      </div>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-muted-foreground" />
    </button>
  )
}
