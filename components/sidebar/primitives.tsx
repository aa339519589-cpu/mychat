"use client"

import { useEffect, useState, type CSSProperties, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { ChevronLeft, Folder, MoreHorizontal, Pencil, Pin, Star, Trash2 } from "lucide-react"

import { ConversationRename } from "@/components/conversation-menu"
import type { Conversation } from "@/lib/chat-data"
import { conversationExcerpt } from "@/lib/data"
import { cn } from "@/lib/utils"
import type { SidebarAnchor } from "./shared"

export function ScreenPanel({ style, title, onBack, action, children }: {
  style: CSSProperties
  title: ReactNode
  onBack: () => void
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="absolute inset-0 flex flex-col bg-sidebar transition-transform duration-[360ms] ease-[cubic-bezier(0.32,0.72,0,1)]" style={style}>
      <div className="flex shrink-0 items-center gap-2 px-4 pb-4 pt-[max(1rem,env(safe-area-inset-top))]">
        <button onClick={onBack} className="-ml-1 shrink-0 rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground" aria-label="返回">
          <ChevronLeft className="size-5" />
        </button>
        <div className="min-w-0 flex-1">
          {typeof title === "string"
            ? <h3 className="truncate text-[16px] font-semibold tracking-tight">{title}</h3>
            : title}
        </div>
        {action}
      </div>
      <div className="flex-1 overflow-y-auto pb-[max(1.5rem,env(safe-area-inset-bottom))]">{children}</div>
    </div>
  )
}

export function NavRow({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-2.5 rounded-2xl px-3 py-2.5 text-sm font-medium text-sidebar-foreground transition-colors hover:bg-sidebar-accent">
      <span className="text-muted-foreground">{icon}</span>{label}
    </button>
  )
}

export function ComingSoon({ icon, title, desc }: { icon: ReactNode; title: string; desc: string }) {
  return (
    <div className="mx-auto flex h-full max-w-xs flex-col items-center justify-center px-6 text-center">
      <div className="mb-4 flex size-16 items-center justify-center rounded-full bg-sidebar-accent/60 text-sidebar-primary">{icon}</div>
      <p className="font-heading text-base tracking-wide text-foreground">{title}</p>
      <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">{desc}</p>
    </div>
  )
}

export function Switch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn("relative h-6 w-11 shrink-0 rounded-full transition-colors", checked ? "bg-sidebar-primary" : "bg-muted-foreground/30")}
    >
      <span className={cn("absolute left-0.5 top-0.5 size-5 rounded-full bg-card shadow transition-transform", checked && "translate-x-5")} />
    </button>
  )
}


export function ConversationRow({ c, isActive, renaming, onSelect, onOpenMenu, onCommitRename, onCancelRename }: {
  c: Conversation
  isActive: boolean
  renaming: boolean
  onSelect: (id: string) => void
  onOpenMenu: (id: string, anchor: SidebarAnchor) => void
  onCommitRename: (id: string, title: string) => void
  onCancelRename: () => void
}) {
  if (renaming) {
    return (
      <div className="px-2 py-1">
        <ConversationRename
          value={c.title}
          onCommit={title => onCommitRename(c.id, title)}
          onCancel={onCancelRename}
          className="w-full rounded-xl border border-sidebar-border bg-background/50 px-3 py-2 text-sm outline-none focus:border-sidebar-primary/50"
        />
      </div>
    )
  }

  const excerpt = conversationExcerpt(c.excerpt)

  return (
    <div className="group relative">
      <button
        onClick={() => onSelect(c.id)}
        className={cn("block w-full rounded-2xl px-4 py-3 pr-9 text-left transition-all duration-150 active:scale-[0.985]", isActive ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60")}
      >
        <div className="flex items-baseline justify-between gap-3">
          <span className="flex min-w-0 items-center gap-1.5">
            {c.pinned && <Pin className="size-3 shrink-0 rotate-45 fill-current text-sidebar-primary/70" />}
            {c.projectId && <Folder className="size-3 shrink-0 text-sidebar-primary/60" />}
            <span className={cn("truncate text-[13px] font-medium leading-snug", isActive ? "text-sidebar-primary" : "text-sidebar-foreground")}>{c.title}</span>
            {c.starred && <Star className="size-3 shrink-0 fill-current text-sidebar-primary/70" />}
          </span>
          <span className="shrink-0 text-[10px] tracking-wider text-muted-foreground">{c.date}</span>
        </div>
        {excerpt && <p className="mt-1.5 line-clamp-2 text-[12px] leading-relaxed text-muted-foreground">{excerpt}</p>}
      </button>
      <button
        onClick={e => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); onOpenMenu(c.id, { top: r.top, bottom: r.bottom, right: r.right }) }}
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1.5 text-muted-foreground/50 transition-all hover:bg-sidebar-accent hover:text-foreground active:scale-90"
        aria-label="更多"
      >
        <MoreHorizontal className="size-4" />
      </button>
    </div>
  )
}

function ActionRow({ icon, label, onClick, danger }: { icon: ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick} className={cn("flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] transition-colors active:scale-[0.98]", danger ? "text-destructive hover:bg-destructive/10" : "text-foreground hover:bg-sidebar-accent/60")}>
      <span className={cn("shrink-0", danger ? "text-destructive" : "text-muted-foreground")}>{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  )
}

// ── 共享弹层外壳：右锚定在触发点旁，portal 到 body，淡入+轻微缩放 ──
// 宽度贴合内容（w-max）并夹在 192–272px 之间，避免半屏宽的大片留白；竖向超界时朝上展开。
function PopoverShell({ anchor, estH, onClose, children }: {
  anchor: SidebarAnchor
  estH: number
  onClose: () => void
  children: ReactNode
}) {
  const [shown, setShown] = useState(false)
  useEffect(() => { const r = requestAnimationFrame(() => setShown(true)); return () => cancelAnimationFrame(r) }, [])
  if (typeof document === "undefined") return null

  const vw = window.innerWidth, vh = window.innerHeight
  const openUp = anchor.bottom + estH > vh - 12
  const right = Math.max(10, vw - anchor.right)
  const pos: CSSProperties = {
    position: "fixed", right,
    transformOrigin: openUp ? "bottom right" : "top right",
    ...(openUp ? { bottom: vh - anchor.top + 6 } : { top: anchor.bottom + 6 }),
  }

  return createPortal(
    <div className="fixed inset-0 z-[80]" onClick={onClose}>
      <div
        onClick={e => e.stopPropagation()}
        style={pos}
        className={cn(
          "w-max min-w-[148px] max-w-[192px] overflow-hidden rounded-2xl border border-sidebar-border bg-card p-0.5 shadow-xl transition-all duration-150 ease-out",
          shown ? "scale-100 opacity-100" : "scale-95 opacity-0",
        )}
      >
        {children}
      </div>
    </div>,
    document.body,
  )
}

// 项目"更多菜单"：重命名 / 删除（删除二次确认，避免误删整个项目）
export function ProjectMenu({ anchor, onClose, onRename, onDelete }: {
  anchor: SidebarAnchor
  onClose: () => void
  onRename: () => void
  onDelete: () => void
}) {
  const [confirm, setConfirm] = useState(false)
  return (
    <PopoverShell anchor={anchor} estH={128} onClose={onClose}>
      <ActionRow icon={<Pencil className="size-4" />} label="重命名项目" onClick={onRename} />
      <div className="my-1 border-t border-sidebar-border/60" />
      <ActionRow
        icon={<Trash2 className="size-4" />}
        label={confirm ? "确认删除此项目" : "删除此项目"}
        danger
        onClick={() => { if (confirm) onDelete(); else setConfirm(true) }}
      />
    </PopoverShell>
  )
}

// ── 使用额度展示 ──
