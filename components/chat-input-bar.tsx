"use client"

import type { RefObject } from "react"
import { ArrowRight, ArrowUp, ChevronDown, Image as ImageIcon, Server, Sparkles, Square, Video } from "lucide-react"
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
  const modelIcon = outputIcon(activeOutputKind) ?? <Sparkles className="size-[1.1rem] shrink-0" />
  const SendIcon = value.trim() ? ArrowUp : ArrowRight

  return (
    <>
      <textarea ref={textareaRef} rows={1} value={value} disabled={disabled} onChange={event => { onValueChange(event.target.value); onResize() }} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !disabled && !isLoading && !sendPending) { event.preventDefault(); onSubmit() } }} placeholder={placeholder} className={cn("order-1 block min-h-[3.25rem] w-full basis-full resize-none bg-transparent px-2.5 pb-1 pt-1.5 text-[16px] font-normal leading-6 tracking-[-0.01em] text-foreground outline-none placeholder:font-normal placeholder:text-[#8F8F8F] disabled:cursor-wait dark:text-white dark:placeholder:text-white/45", mobile ? "max-h-[120px]" : "max-h-[180px]")} />
      <button type="button" onClick={onOpenModel} aria-label="选择模型" title={activeModelLabel} className={cn("fluid-press order-3 flex h-11 shrink-0 items-center justify-center gap-1 rounded-full text-[#9A9A9A] hover:bg-secondary/70 hover:text-foreground dark:text-white/55 dark:hover:bg-white/10 dark:hover:text-white", mobile ? "w-11" : "min-w-11 max-w-[11rem] px-2.5")}>
        {modelIcon}
        <span className={cn("min-w-0 truncate text-xs", mobile && "sr-only")}>{activeModelLabel}</span>
        {!mobile && <ChevronDown className="size-3 shrink-0" />}
      </button>
      {isLoading ? (
        <button onClick={onStop} aria-label="停止生成" className="fluid-press fluid-icon-press order-4 ml-auto flex size-11 shrink-0 items-center justify-center rounded-full bg-foreground text-background shadow-sm hover:opacity-80"><Square className="size-3.5 fill-current" /></button>
      ) : (
        <button
          onClick={onSubmit}
          disabled={!canSend}
          aria-label="发送"
          style={{ backgroundImage: "linear-gradient(135deg, var(--send-gradient-start) 0%, var(--send-gradient-mid) 48%, var(--send-gradient-end) 100%)" }}
          className={cn(
            "fluid-press fluid-icon-press order-4 ml-auto flex size-11 shrink-0 items-center justify-center rounded-full border border-[var(--chat-surface-border)] text-[var(--send-gradient-foreground)] shadow-[0_3px_12px_rgba(8,8,8,0.055)]",
            canSend ? "hover:brightness-[0.985]" : "cursor-not-allowed",
          )}
        >
          <SendIcon className="size-[1.15rem]" />
        </button>
      )}
    </>
  )
}

function outputIcon(kind?: string) {
  if (kind === "image") return <ImageIcon className="size-[1.1rem] shrink-0" />
  if (kind === "video") return <Video className="size-[1.1rem] shrink-0" />
  if (kind === "chat") return <Server className="size-[1.1rem] shrink-0" />
  return null
}
