"use client"

import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import type { PointerEvent as ReactPointerEvent } from "react"
import { ChevronRight, Code2, Folder, LogOut, PanelLeft, Plus, Settings, Shapes } from "lucide-react"
import type { Conversation } from "@/lib/chat-data"
import { ConversationRow, NavRow } from "@/components/sidebar/primitives"
import type { SidebarAnchor } from "./shared"
import { cn } from "@/lib/utils"
import { PANEL_SPRING, transitionFor } from "@/components/motion/fluid"

type DragProps = {
  onClose?: () => void
  onDragStart?: (event: ReactPointerEvent<HTMLDivElement>) => void
  onDragMove?: (event: ReactPointerEvent<HTMLDivElement>) => void
  onDragEnd?: (event: ReactPointerEvent<HTMLDivElement>) => void
  onDragCancel?: (event: ReactPointerEvent<HTMLDivElement>) => void
}

export type SidebarRootContentProps = DragProps & {
  stackDepth: number
  activeId: string
  rootConversations: Conversation[]
  renamingId: string | null
  email: string
  userMenuOpen: boolean
  onNew: () => void
  onOpenProjects: () => void
  onOpenArtifacts: () => void
  onOpenCode: () => void
  onSelect: (id: string) => void
  onOpenMenu: (id: string, anchor: SidebarAnchor) => void
  onCommitRename: (id: string, title: string) => void
  onCancelRename: () => void
  onToggleUserMenu: () => void
  onCloseUserMenu: () => void
  onOpenSettings: () => void
  onLogout: () => void
}

export function SidebarRootContent(props: SidebarRootContentProps) {
  const reducedMotion = useReducedMotion()
  return (
    <motion.div
      initial={false}
      animate={rootAnimation(props.stackDepth, reducedMotion)}
      transition={transitionFor(reducedMotion, PANEL_SPRING)}
      inert={props.stackDepth > 0}
      className="relative flex h-full flex-col origin-left"
    >
      <SidebarHeader {...props} />
      <SidebarNavigation onNew={props.onNew} onOpenProjects={props.onOpenProjects} onOpenArtifacts={props.onOpenArtifacts} onOpenCode={props.onOpenCode} />
      <SidebarConversationList {...props} />
      <SidebarFooter email={props.email} userMenuOpen={props.userMenuOpen} onToggle={props.onToggleUserMenu} />
      <SidebarUserMenu open={props.userMenuOpen} reducedMotion={reducedMotion} onClose={props.onCloseUserMenu} onOpenSettings={props.onOpenSettings} onLogout={props.onLogout} />
    </motion.div>
  )
}

function rootAnimation(depth: number, reducedMotion: boolean | null) {
  if (reducedMotion) return { opacity: depth > 0 ? 0.72 : 1 }
  return { x: depth > 0 ? -20 : 0, scale: depth > 0 ? 0.985 : 1, opacity: depth > 0 ? 0.82 : 1 }
}

function SidebarHeader({ onClose, onDragStart, onDragMove, onDragEnd, onDragCancel }: DragProps) {
  return (
    <div data-testid="sidebar-drag-handle" onPointerDown={onDragStart} onPointerMove={onDragMove} onPointerUp={onDragEnd} onPointerCancel={onDragCancel} className="flex touch-none items-center px-5 pb-2 pt-[max(1rem,env(safe-area-inset-top))] md:touch-auto">
      <span className="font-heading text-[22px] font-semibold leading-none tracking-[0.02em]">MyChat</span>
      <span aria-hidden="true" className="sr-only">My Chat</span>
      {onClose && <button onPointerDown={event => event.stopPropagation()} onClick={onClose} aria-label="收起侧栏" className="fluid-press fluid-icon-press fluid-touch-target ml-auto flex size-11 items-center justify-center rounded-full text-muted-foreground hover:bg-sidebar-accent hover:text-foreground md:hidden"><PanelLeft className="size-5" /></button>}
    </div>
  )
}

function SidebarNavigation({ onNew, onOpenProjects, onOpenArtifacts, onOpenCode }: { onNew: () => void; onOpenProjects: () => void; onOpenArtifacts: () => void; onOpenCode: () => void }) {
  return (
    <nav className="mx-4 grid gap-0.5 pb-1">
      <NavRow icon={<Plus className="size-5" />} label="新对话" onClick={onNew} />
      <NavRow icon={<Folder className="size-5" />} label="项目" onClick={onOpenProjects} />
      <NavRow icon={<Shapes className="size-5" />} label="作品" onClick={onOpenArtifacts} />
      <NavRow icon={<Code2 className="size-5" />} label="代码" onClick={onOpenCode} />
    </nav>
  )
}

function SidebarConversationList({ activeId, rootConversations, renamingId, onSelect, onOpenMenu, onCommitRename, onCancelRename }: Pick<SidebarRootContentProps, "activeId" | "rootConversations" | "renamingId" | "onSelect" | "onOpenMenu" | "onCommitRename" | "onCancelRename">) {
  return (
    <>
      <div className="mx-7 my-2 border-t border-sidebar-border/60" />
      <p className="px-7 pb-1 text-[10px] tracking-[0.2em] text-muted-foreground/70">近期</p>
      <div className="flex-1 space-y-1 overflow-y-auto px-3 pb-3">
        {rootConversations.length === 0 ? <p className="px-4 py-6 text-center text-[12px] italic text-muted-foreground/60">还没有对谈</p> : rootConversations.map(c => <ConversationRow key={c.id} c={c} isActive={c.id === activeId} renaming={renamingId === c.id} onSelect={onSelect} onOpenMenu={onOpenMenu} onCommitRename={onCommitRename} onCancelRename={onCancelRename} />)}
      </div>
    </>
  )
}

function SidebarFooter({ email, userMenuOpen, onToggle }: { email: string; userMenuOpen: boolean; onToggle: () => void }) {
  const initial = (email.slice(0, 1) || "我").toUpperCase()
  return <div className="border-t border-sidebar-border px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3"><button onClick={onToggle} className="fluid-press flex min-h-11 w-full items-center gap-3 rounded-2xl px-2 py-2 text-left hover:bg-sidebar-accent/60"><div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-sidebar-primary/15 text-sm text-sidebar-primary">{initial}</div><span className="min-w-0 flex-1 truncate text-sm text-foreground">{email || "已登录"}</span><ChevronRight className={cn("size-4 shrink-0 text-muted-foreground transition-transform", userMenuOpen && "-rotate-90")} /></button></div>
}

function SidebarUserMenu({ open, reducedMotion, onClose, onOpenSettings, onLogout }: { open: boolean; reducedMotion: boolean | null; onClose: () => void; onOpenSettings: () => void; onLogout: () => void }) {
  return (
    <AnimatePresence initial={false}>{open && <motion.div key="user-menu" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={transitionFor(reducedMotion)} className="absolute inset-0 z-30"><button className="absolute inset-0 cursor-default" aria-label="关闭菜单" onClick={onClose} /><motion.div initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.98 }} transition={transitionFor(reducedMotion)} className="fluid-material-strong absolute bottom-[calc(4rem+env(safe-area-inset-bottom,0px))] left-3 right-3 overflow-hidden rounded-2xl border border-sidebar-border"><button onClick={onOpenSettings} className="fluid-press flex min-h-11 w-full items-center gap-3 px-4 py-3 text-sm text-foreground hover:bg-sidebar-accent/60"><Settings className="size-4 text-muted-foreground" />设置</button><div className="border-t border-sidebar-border/50" /><button onClick={onLogout} className="fluid-press flex min-h-11 w-full items-center gap-3 px-4 py-3 text-sm text-muted-foreground hover:bg-sidebar-accent/40 hover:text-destructive"><LogOut className="size-4" />退出登录</button></motion.div></motion.div>}</AnimatePresence>
  )
}
