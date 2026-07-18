"use client"

import { useState, type CSSProperties, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { motion, useReducedMotion } from "motion/react"
import { ChevronLeft, Folder, MoreHorizontal, Pencil, Pin, Star, Trash2 } from "lucide-react"

import { ConversationRename } from "@/components/conversation-menu"
import type { Conversation } from "@/lib/chat-data"
import { conversationExcerpt } from "@/lib/data"
import { cn } from "@/lib/utils"
import type { SidebarAnchor } from "./shared"
import { MOMENTUM_SPRING, PANEL_SPRING, POPOVER_SPRING, shouldDismissGesture, transitionFor } from "@/components/motion/fluid"
import { useMediaQuery } from "@/components/literary-chat/use-media-query"

export function ScreenPanel({ open, style, title, onBack, action, children }: {
  open: boolean
  style: CSSProperties
  title: ReactNode
  onBack: () => void
  action?: ReactNode
  children: ReactNode
}) {
  const reducedMotion = useReducedMotion()
  const canSwipeBack = useMediaQuery("(max-width: 767px) and (pointer: coarse)")

  return (
    <motion.div
      initial={false}
      animate={reducedMotion
        ? { x: 0, opacity: open ? 1 : 0 }
        : { x: open ? 0 : "100%", opacity: 1 }}
      transition={transitionFor(reducedMotion, PANEL_SPRING)}
      drag={open && canSwipeBack && !reducedMotion ? "x" : false}
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={{ left: 0, right: 0.34 }}
      dragDirectionLock
      dragMomentum={false}
      dragSnapToOrigin
      onDragEnd={(_, info) => {
        if (shouldDismissGesture({
          offset: info.offset.x,
          velocity: info.velocity.x,
          size: window.innerWidth,
          direction: "positive",
        })) onBack()
      }}
      aria-hidden={!open}
      inert={!open}
      className="fluid-drag-surface absolute inset-0 flex flex-col bg-sidebar"
      style={style}
    >
      <div className="flex shrink-0 items-center gap-2 px-4 pb-4 pt-[max(1rem,env(safe-area-inset-top))]">
        <button onClick={onBack} className="fluid-press fluid-icon-press fluid-touch-target -ml-1 flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-sidebar-accent hover:text-foreground" aria-label="返回">
          <ChevronLeft className="size-5" />
        </button>
        <div className="min-w-0 flex-1">
          {typeof title === "string"
            ? <h3 className="truncate text-[16px] font-semibold tracking-tight">{title}</h3>
            : title}
        </div>
        {action}
      </div>
      <div className="fluid-scroll flex-1 overflow-y-auto pb-[max(1.5rem,env(safe-area-inset-bottom))]">{children}</div>
    </motion.div>
  )
}

export function NavRow({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="fluid-press grid min-h-12 w-full grid-cols-[1.5rem_minmax(0,1fr)] items-center gap-3 rounded-2xl px-3 py-3 text-left text-[15px] font-medium text-sidebar-foreground hover:bg-sidebar-accent">
      <span className="flex size-6 items-center justify-center text-sidebar-primary">{icon}</span>
      <span>{label}</span>
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
  const reducedMotion = useReducedMotion()
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="fluid-press relative h-11 w-11 shrink-0 rounded-full"
    >
      <span className={cn("absolute inset-x-0 top-2.5 h-6 rounded-full", checked ? "bg-sidebar-primary" : "bg-muted-foreground/30")} />
      <motion.span
        initial={false}
        animate={{ x: checked ? 20 : 0 }}
        transition={transitionFor(reducedMotion, MOMENTUM_SPRING)}
        className="absolute left-0.5 top-3 size-5 rounded-full bg-card shadow"
      />
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
        className={cn(
          "fluid-press block min-h-11 w-full rounded-2xl px-4 py-3 pr-12 text-left",
          isActive
            ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-[0_8px_22px_rgb(4_21_47/0.16)]"
            : "hover:bg-sidebar-primary/[0.07]",
        )}
      >
        <div className="flex items-baseline justify-between gap-3">
          <span className="flex min-w-0 items-center gap-1.5">
            {c.pinned && <Pin className={cn("size-3 shrink-0 rotate-45 fill-current", isActive ? "text-sidebar-primary-foreground/75" : "text-sidebar-primary/70")} />}
            {c.projectId && <Folder className={cn("size-3 shrink-0", isActive ? "text-sidebar-primary-foreground/70" : "text-sidebar-primary/60")} />}
            <span className={cn("truncate text-[13px] font-medium leading-snug", isActive ? "text-sidebar-primary-foreground" : "text-sidebar-foreground")}>{c.title}</span>
            {c.starred && <Star className={cn("size-3 shrink-0 fill-current", isActive ? "text-sidebar-primary-foreground/75" : "text-sidebar-primary/70")} />}
          </span>
          <span className={cn("shrink-0 text-[10px] tracking-wider", isActive ? "text-sidebar-primary-foreground/65" : "text-muted-foreground")}>{c.date}</span>
        </div>
        {excerpt && <p className={cn("mt-1.5 line-clamp-2 text-[12px] leading-relaxed", isActive ? "text-sidebar-primary-foreground/72" : "text-muted-foreground")}>{excerpt}</p>}
      </button>
      <button
        onClick={e => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); onOpenMenu(c.id, { top: r.top, bottom: r.bottom, right: r.right }) }}
        className={cn(
          "fluid-press fluid-icon-press absolute right-0 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-full",
          isActive
            ? "text-sidebar-primary-foreground/65 hover:bg-white/10 hover:text-sidebar-primary-foreground"
            : "text-muted-foreground/50 hover:bg-sidebar-primary/[0.08] hover:text-foreground",
        )}
        aria-label="更多"
      >
        <MoreHorizontal className="size-4" />
      </button>
    </div>
  )
}

function ActionRow({ icon, label, onClick, danger }: { icon: ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick} className={cn("fluid-press fluid-touch-target flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px]", danger ? "text-destructive hover:bg-destructive/10" : "text-foreground hover:bg-sidebar-accent/60")}>
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
  const reducedMotion = useReducedMotion()
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
    <motion.div
      className="fixed inset-0 z-[80]"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={transitionFor(reducedMotion)}
      onClick={onClose}
    >
      <motion.div
        onClick={e => e.stopPropagation()}
        style={pos}
        initial={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.94, y: openUp ? 6 : -6 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: openUp ? 4 : -4 }}
        transition={transitionFor(reducedMotion, POPOVER_SPRING)}
        className="fluid-material-strong w-max min-w-[164px] max-w-[224px] overflow-hidden rounded-xl border border-sidebar-border p-1"
      >
        {children}
      </motion.div>
    </motion.div>,
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
