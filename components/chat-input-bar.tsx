"use client"

import type { RefObject } from "react"
import { ArrowUp, ChevronDown, Image as ImageIcon, Server, Square, Video } from "lucide-react"
import { cn } from "@/lib/utils"

export function ComposerBar({ mobile, value, onValueChange, textareaRef, onResize, onSubmit, disabled, isLoading, sendPending, activeTier, activeModelLabel, activeOutputKind, canSend, onStop, onOpenModel }: {
  mobile: boolean
  value: string
  onValueChange: (value: string) => void
  textareaRef: RefObject<HTMLTextAreaElement | null>
  onResize: () => void
  onSubmit: () => void
  disabled: boolean
  isLoading: boolean
  sendPending: boolean
  activeTier: string
  activeModelLabel: string
  activeOutputKind?: string
  canSend: boolean
  onStop: () => void
  onOpenModel: () => void
}) {
  const placeholder = disabled ? "正在同步会话……" : activeTier === "绘影" ? "描述图片，也可附上参考图……" : activeTier === "录像" ? "描述视频，也可附上参考图……" : "说点什么……"
  return (
    <>
      <textarea ref={textareaRef} rows={1} value={value} disabled={disabled} onChange={event => { onValueChange(event.target.value); onResize() }} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !disabled && !isLoading && !sendPending) { event.preventDefault(); onSubmit() } }} placeholder={placeholder} className={cn("block min-h-11 min-w-0 flex-1 resize-none bg-transparent py-2.5 text-[15px] leading-6 tracking-wide text-secondary-foreground outline-none placeholder:italic placeholder:text-muted-foreground disabled:cursor-wait dark:text-white", mobile ? "max-h-[120px]" : "max-h-[180px]")} />
      <button type="button" onClick={onOpenModel} aria-label="选择模型" className="fluid-press flex h-11 min-w-0 max-w-[6rem] shrink-0 items-center gap-1 rounded-[0.7rem] px-2 text-xs text-muted-foreground hover:bg-background/40 hover:text-foreground dark:hover:bg-white/10 sm:max-w-[11rem] sm:px-2.5">{outputIcon(activeOutputKind)}<span className="min-w-0 truncate">{activeModelLabel}</span><ChevronDown className="size-3 shrink-0" /></button>
      {isLoading ? <button onClick={onStop} aria-label="停止生成" className="fluid-press fluid-icon-press flex size-11 shrink-0 items-center justify-center rounded-full bg-foreground text-background hover:opacity-80"><Square className="size-3.5 fill-current" /></button> : <button onClick={onSubmit} disabled={!canSend} aria-label="发送" className={cn("fluid-press fluid-icon-press flex size-11 shrink-0 items-center justify-center rounded-full", canSend ? "bg-primary text-primary-foreground hover:opacity-90" : "cursor-not-allowed text-muted-foreground/30")}><ArrowUp className="size-4" /></button>}
    </>
  )
}

function outputIcon(kind?: string) {
  if (kind === "image") return <ImageIcon className="size-3.5 shrink-0" />
  if (kind === "video") return <Video className="size-3.5 shrink-0" />
  if (kind === "chat") return <Server className="size-3.5 shrink-0" />
  return null
}
