"use client"

import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { motion, useReducedMotion } from "motion/react"
import { ChevronLeft, Folder, Pencil, Pin, Star, Trash2, X } from "lucide-react"
import type { Conversation } from "@/lib/chat-data"
import type { Project } from "@/lib/project-data"
import { cn } from "@/lib/utils"
import { POPOVER_SPRING, transitionFor } from "@/components/motion/fluid"

type ConversationMenuAnchor = {
  top?: number
  bottom: number
  left?: number
  right?: number
}

type ConversationMenuProps = {
  conversation: Conversation
  anchor: ConversationMenuAnchor
  projects: Project[]
  onClose: () => void
  onToggleStar: () => void
  onTogglePin: () => void
  onRename: () => void
  onMove: (projectId: string | null) => void
  onDelete: () => void
}

export function ConversationMenu({
  conversation, anchor, projects, onClose, onToggleStar, onTogglePin, onRename, onMove, onDelete,
}: ConversationMenuProps) {
  const [picker, setPicker] = useState(false)
  const reducedMotion = useReducedMotion()
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [onClose])
  if (typeof document === "undefined") return null

  return (
    <ConversationMenuPortal
      conversation={conversation}
      anchor={anchor}
      projects={projects}
      picker={picker}
      reducedMotion={reducedMotion}
      onPickerChange={setPicker}
      onClose={onClose}
      onToggleStar={onToggleStar}
      onTogglePin={onTogglePin}
      onRename={onRename}
      onMove={onMove}
      onDelete={onDelete}
    />
  )
}

function ConversationMenuPortal({
  conversation,
  anchor,
  projects,
  picker,
  reducedMotion,
  onPickerChange,
  onClose,
  onToggleStar,
  onTogglePin,
  onRename,
  onMove,
  onDelete,
}: ConversationMenuProps & {
  picker: boolean
  reducedMotion: boolean | null
  onPickerChange: (open: boolean) => void
}) {

  const estimatedHeight = picker ? Math.min(320, 54 + availableProjectHeight(projects.length)) : 224
  const opensUp = anchor.top !== undefined && anchor.bottom + estimatedHeight > window.innerHeight - 12
  const position: React.CSSProperties = {
    position: "fixed",
    transformOrigin: `${anchor.right !== undefined ? "right" : "left"} ${opensUp ? "bottom" : "top"}`,
    ...(opensUp
      ? { bottom: window.innerHeight - (anchor.top ?? anchor.bottom) + 6 }
      : { top: anchor.bottom + 6 }),
  }
  if (anchor.right !== undefined) position.right = Math.max(10, window.innerWidth - anchor.right)
  else position.left = Math.max(8, Math.min(anchor.left ?? 8, window.innerWidth - 200))
  const available = projects.filter(project => project.id !== conversation.projectId)

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
        style={position}
        onClick={event => event.stopPropagation()}
        initial={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.94, y: opensUp ? 6 : -6 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: opensUp ? 4 : -4 }}
        transition={transitionFor(reducedMotion, POPOVER_SPRING)}
        className="fluid-material-strong w-max min-w-[164px] max-w-[224px] overflow-hidden rounded-xl border border-border/60 p-1"
      >
        <ConversationMenuBody
          conversation={conversation}
          availableProjects={available}
          picker={picker}
          onPickerChange={onPickerChange}
          onToggleStar={onToggleStar}
          onTogglePin={onTogglePin}
          onRename={onRename}
          onMove={onMove}
          onDelete={onDelete}
        />
      </motion.div>
    </motion.div>,
    document.body,
  )
}

function ConversationMenuBody({
  conversation,
  availableProjects,
  picker,
  onPickerChange,
  onToggleStar,
  onTogglePin,
  onRename,
  onMove,
  onDelete,
}: Pick<ConversationMenuProps, "conversation" | "onToggleStar" | "onTogglePin" | "onRename" | "onMove" | "onDelete"> & {
  availableProjects: Project[]
  picker: boolean
  onPickerChange: (open: boolean) => void
}) {
  if (picker) {
    return (
      <>
        <button onClick={() => onPickerChange(false)} className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-[12px] text-muted-foreground hover:bg-secondary/60">
          <ChevronLeft className="size-4" />加入项目
        </button>
        <div className="max-h-[44vh] overflow-y-auto">
          {conversation.projectId && <MenuRow icon={<X className="size-4" />} label="移出当前项目" onClick={() => onMove(null)} />}
          {availableProjects.map(project => <MenuRow key={project.id} icon={<Folder className="size-4" />} label={project.name} onClick={() => onMove(project.id)} />)}
          {!availableProjects.length && !conversation.projectId && <p className="px-3 py-4 text-center text-xs italic text-muted-foreground/70">还没有项目</p>}
        </div>
      </>
    )
  }

  return (
    <>
      <MenuRow icon={<Star className={cn("size-4", conversation.starred && "fill-current text-primary")} />} label={conversation.starred ? "取消收藏" : "收藏"} onClick={onToggleStar} />
      <MenuRow icon={<Pencil className="size-4" />} label="重命名" onClick={onRename} />
      <MenuRow icon={<Folder className="size-4" />} label="加入项目" onClick={() => onPickerChange(true)} />
      <MenuRow icon={<Pin className="size-4" />} label={conversation.pinned ? "取消置顶" : "置顶"} onClick={onTogglePin} />
      <div className="my-1 border-t border-border/60" />
      <MenuRow icon={<Trash2 className="size-4" />} label="删除" danger onClick={onDelete} />
    </>
  )
}

function availableProjectHeight(projectCount: number) {
  return Math.min(projectCount + 1, 6) * 44
}

function MenuRow({ icon, label, onClick, danger = false }: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick} className={cn("fluid-press fluid-touch-target flex min-h-11 w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12px]", danger ? "text-destructive hover:bg-destructive/10" : "text-foreground hover:bg-secondary/60")}>
      <span className={danger ? "text-destructive" : "text-muted-foreground"}>{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  )
}

export function ConversationRename({ value, onCommit, onCancel, className }: {
  value: string
  onCommit: (value: string) => void
  onCancel: () => void
  className?: string
}) {
  const [draft, setDraft] = useState(value)
  const done = useRef(false)
  const commit = () => {
    if (done.current) return
    done.current = true
    const title = draft.trim()
    if (title) onCommit(title)
    else onCancel()
  }

  return <input autoFocus value={draft} onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={event => {
    if (event.key === "Enter") { event.preventDefault(); commit() }
    if (event.key === "Escape") { done.current = true; onCancel() }
  }} className={className} />
}
