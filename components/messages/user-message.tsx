"use client"

import { Check, FileText, Pencil, RefreshCw, X } from "lucide-react"
import Image from "next/image"

import type { Message } from "@/lib/chat-data"
import { cn } from "@/lib/utils"

export type UserMessageProps = {
  message: Message
  active: boolean
  editing: boolean
  editDraft: string
  isLoading: boolean
  onToggleActive: () => void
  onStartEdit: () => void
  onEditDraft: (value: string) => void
  onCancelEdit: () => void
  onCommitEdit: () => void
  onRegenerate: () => void
}

export function UserMessage({
  message,
  active,
  editing,
  editDraft,
  isLoading,
  onToggleActive,
  onStartEdit,
  onEditDraft,
  onCancelEdit,
  onCommitEdit,
  onRegenerate,
}: UserMessageProps) {
  return (
    <div className="flex flex-col items-end">
      {message.images && message.images.length > 0 && (
        <div className="mb-2 flex flex-wrap justify-end gap-2">
          {message.images.map((image, index) => (
            <Image
              key={index}
              src={image}
              alt=""
              width={240}
              height={192}
              unoptimized
              className="max-h-48 max-w-[240px] rounded-2xl border border-border/30 object-cover"
            />
          ))}
        </div>
      )}
      {message.files && message.files.length > 0 && (
        <div className="mb-2 flex flex-wrap justify-end gap-2">
          {message.files.map((name, index) => (
            <div key={index} className="flex items-center gap-1.5 rounded-2xl border border-border/40 bg-secondary/60 px-3.5 py-2.5">
              <FileText className="size-4 shrink-0 text-muted-foreground" />
              <span className="max-w-[180px] truncate text-sm text-secondary-foreground">{name}</span>
            </div>
          ))}
        </div>
      )}
      {message.content && (
        editing ? (
          <div className="max-w-[84%] min-w-0 rounded-[0.78rem] border border-border/50 bg-secondary/75 px-3.5 py-1.5 text-left text-secondary-foreground shadow-sm md:max-w-[80%] dark:border-white/10 dark:bg-[#151515] dark:text-white">
            <textarea
              value={editDraft}
              onChange={event => onEditDraft(event.target.value)}
              onKeyDown={event => {
                if (event.key === "Escape") onCancelEdit()
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) onCommitEdit()
              }}
              autoFocus
              rows={Math.min(6, Math.max(2, editDraft.split("\n").length))}
              className="w-full min-w-0 resize-none bg-transparent font-sans text-[16px] font-[500] leading-[1.38] tracking-[0.001em] text-secondary-foreground outline-none [overflow-wrap:anywhere] md:text-[17px] dark:text-white"
            />
          </div>
        ) : (
          <div
            role="button"
            tabIndex={0}
            onClick={onToggleActive}
            onKeyDown={event => { if (event.key === "Enter") onToggleActive() }}
            className="max-w-[84%] min-w-0 cursor-pointer rounded-[0.78rem] border border-border/50 bg-secondary/75 px-3.5 py-1.5 text-left text-secondary-foreground shadow-sm md:max-w-[80%] dark:border-white/10 dark:bg-[#151515] dark:text-white"
          >
            <p className="break-words text-left font-sans text-[16px] font-[500] not-italic leading-[1.38] tracking-[0.001em] text-secondary-foreground [overflow-wrap:anywhere] md:text-[17px] dark:text-white">{message.content}</p>
          </div>
        )
      )}
      <div className={cn(
        "mt-1 flex items-center justify-end gap-1 overflow-hidden pr-1 transition-all duration-300 ease-out",
        active || editing
          ? "max-h-10 translate-y-0 opacity-100"
          : "pointer-events-none max-h-0 -translate-y-1 opacity-0",
      )}>
        {editing ? (
          <>
            <button onClick={onCommitEdit} disabled={!editDraft.trim() || isLoading} title="保存并重新回复" className="rounded-full p-2 text-muted-foreground transition-colors hover:bg-primary/10 hover:text-foreground disabled:opacity-30">
              <Check className="size-4" />
            </button>
            <button onClick={onCancelEdit} title="取消" className="rounded-full p-2 text-muted-foreground transition-colors hover:bg-primary/10 hover:text-foreground">
              <X className="size-4" />
            </button>
          </>
        ) : (
          <>
            <button onClick={onStartEdit} disabled={isLoading} title="编辑" className="rounded-full p-2 text-muted-foreground transition-colors hover:bg-primary/10 hover:text-foreground disabled:opacity-30">
              <Pencil className="size-4" />
            </button>
            <button onClick={onRegenerate} disabled={isLoading} title="从这里重新回复" className="rounded-full p-2 text-muted-foreground transition-colors hover:bg-primary/10 hover:text-foreground disabled:opacity-30">
              <RefreshCw className="size-4" />
            </button>
          </>
        )}
      </div>
    </div>
  )
}
