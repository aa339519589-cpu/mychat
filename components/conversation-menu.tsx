"use client"

import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { ChevronLeft, Folder, Pencil, Pin, Star, Trash2, X } from "lucide-react"
import type { Conversation } from "@/lib/chat-data"
import type { Project } from "@/lib/project-data"
import { cn } from "@/lib/utils"

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
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(frame)
  }, [])
  if (typeof document === "undefined") return null

  const position: React.CSSProperties = { position: "fixed", top: anchor.bottom + 6 }
  if (anchor.right !== undefined) position.right = Math.max(10, window.innerWidth - anchor.right)
  else position.left = Math.max(8, Math.min(anchor.left ?? 8, window.innerWidth - 200))
  const available = projects.filter(project => project.id !== conversation.projectId)

  return createPortal(
    <div className="fixed inset-0 z-[80]" onClick={onClose}>
      <div
        style={position}
        onClick={event => event.stopPropagation()}
        className={cn(
          "w-max min-w-[148px] max-w-[192px] overflow-hidden rounded-2xl border border-border/60 bg-popover p-0.5 shadow-xl transition-all duration-150 ease-out",
          shown ? "scale-100 opacity-100" : "scale-95 opacity-0",
        )}
      >
        {picker ? (
          <>
            <button onClick={() => setPicker(false)} className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-[12px] text-muted-foreground hover:bg-secondary/60">
              <ChevronLeft className="size-4" />加入项目
            </button>
            <div className="max-h-[44vh] overflow-y-auto">
              {conversation.projectId && <MenuRow icon={<X className="size-4" />} label="移出当前项目" onClick={() => onMove(null)} />}
              {available.map(project => <MenuRow key={project.id} icon={<Folder className="size-4" />} label={project.name} onClick={() => onMove(project.id)} />)}
              {!available.length && !conversation.projectId && <p className="px-3 py-4 text-center text-xs italic text-muted-foreground/70">还没有项目</p>}
            </div>
          </>
        ) : (
          <>
            <MenuRow icon={<Star className={cn("size-4", conversation.starred && "fill-current text-primary")} />} label={conversation.starred ? "取消收藏" : "收藏"} onClick={onToggleStar} />
            <MenuRow icon={<Pencil className="size-4" />} label="重命名" onClick={onRename} />
            <MenuRow icon={<Folder className="size-4" />} label="加入项目" onClick={() => setPicker(true)} />
            <MenuRow icon={<Pin className="size-4" />} label={conversation.pinned ? "取消置顶" : "置顶"} onClick={onTogglePin} />
            <div className="my-1 border-t border-border/60" />
            <MenuRow icon={<Trash2 className="size-4" />} label="删除" danger onClick={onDelete} />
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}

function MenuRow({ icon, label, onClick, danger = false }: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick} className={cn("flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] active:scale-[0.98]", danger ? "text-destructive hover:bg-destructive/10" : "text-foreground hover:bg-secondary/60")}>
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
