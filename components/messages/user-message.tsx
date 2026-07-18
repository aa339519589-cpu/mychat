"use client"

import { Check, FileText, Pencil, RefreshCw, X } from "lucide-react"
import Image from "next/image"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"

import type { Message } from "@/lib/chat-data"
import { UI_SPRING, transitionFor } from "@/components/motion/fluid"

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
  const reducedMotion = useReducedMotion()
  return (
    <div className="flex flex-col items-end">
      <UserMessageAttachments message={message} />
      <UserMessageContent
        message={message}
        editing={editing}
        editDraft={editDraft}
        onToggleActive={onToggleActive}
        onEditDraft={onEditDraft}
        onCancelEdit={onCancelEdit}
        onCommitEdit={onCommitEdit}
      />
      <UserMessageActions
        active={active}
        editing={editing}
        editDraft={editDraft}
        isLoading={isLoading}
        reducedMotion={reducedMotion}
        onCommitEdit={onCommitEdit}
        onCancelEdit={onCancelEdit}
        onStartEdit={onStartEdit}
        onRegenerate={onRegenerate}
      />
    </div>
  )
}

function UserMessageAttachments({ message }: { message: Message }) {
  return (
    <>
      {message.images && message.images.length > 0 && (
        <div className="mb-2 flex flex-wrap justify-end gap-2">
          {message.images.map((image, index) => (
            <Image key={index} src={image} alt="" width={240} height={192} unoptimized className="max-h-48 max-w-[240px] rounded-2xl border border-border/30 object-cover" />
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
    </>
  )
}

function UserMessageContent({
  message,
  editing,
  editDraft,
  onToggleActive,
  onEditDraft,
  onCancelEdit,
  onCommitEdit,
}: Pick<UserMessageProps, "message" | "editing" | "editDraft" | "onToggleActive" | "onEditDraft" | "onCancelEdit" | "onCommitEdit">) {
  if (!message.content) return null
  if (editing) {
    return (
      <div className="max-w-[84%] min-w-0 rounded-[0.78rem] border border-primary bg-primary px-3.5 py-1.5 text-left text-primary-foreground shadow-[0_6px_18px_rgb(4_21_47/0.16)] md:max-w-[80%]">
        <textarea
          value={editDraft}
          onChange={event => onEditDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key === "Escape") onCancelEdit()
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) onCommitEdit()
          }}
          autoFocus
          rows={Math.min(6, Math.max(2, editDraft.split("\n").length))}
          className="w-full min-w-0 resize-none bg-transparent font-sans text-[16px] font-[500] leading-[1.38] tracking-[0.001em] text-primary-foreground outline-none [overflow-wrap:anywhere] md:text-[17px]"
        />
      </div>
    )
  }
  return (
    <div role="button" tabIndex={0} onClick={onToggleActive} onKeyDown={event => { if (event.key === "Enter") onToggleActive() }} className="fluid-press max-w-[84%] min-w-0 cursor-pointer rounded-[0.78rem] border border-primary bg-primary px-3.5 py-1.5 text-left text-primary-foreground shadow-[0_6px_18px_rgb(4_21_47/0.16)] md:max-w-[80%]">
      <p className="break-words text-left font-sans text-[16px] font-[500] not-italic leading-[1.38] tracking-[0.001em] text-primary-foreground [overflow-wrap:anywhere] md:text-[17px]">{message.content}</p>
    </div>
  )
}

function UserMessageActions({
  active,
  editing,
  editDraft,
  isLoading,
  reducedMotion,
  onCommitEdit,
  onCancelEdit,
  onStartEdit,
  onRegenerate,
}: Pick<UserMessageProps, "active" | "editing" | "editDraft" | "isLoading" | "onCommitEdit" | "onCancelEdit" | "onStartEdit" | "onRegenerate"> & { reducedMotion: boolean | null }) {
  if (!active && !editing) return null
  return (
    <AnimatePresence initial={false}>
      <motion.div
        key="message-actions"
        initial={reducedMotion ? { opacity: 0 } : { opacity: 0, height: 0, y: -4 }}
        animate={{ opacity: 1, height: 44, y: 0 }}
        exit={reducedMotion ? { opacity: 0 } : { opacity: 0, height: 0, y: -4 }}
        transition={transitionFor(reducedMotion, UI_SPRING)}
        className="mt-1 flex items-center justify-end gap-1 overflow-hidden pr-1"
      >
        <ActionButtons
          editing={editing}
          editDraft={editDraft}
          isLoading={isLoading}
          onCommitEdit={onCommitEdit}
          onCancelEdit={onCancelEdit}
          onStartEdit={onStartEdit}
          onRegenerate={onRegenerate}
        />
      </motion.div>
    </AnimatePresence>
  )
}

function ActionButtons({ editing, editDraft, isLoading, onCommitEdit, onCancelEdit, onStartEdit, onRegenerate }: Pick<UserMessageProps, "editing" | "editDraft" | "isLoading" | "onCommitEdit" | "onCancelEdit" | "onStartEdit" | "onRegenerate">) {
  if (editing) {
    return (
      <>
        <button onClick={onCommitEdit} disabled={!editDraft.trim() || isLoading} title="保存并重新回复" className="fluid-press fluid-icon-press flex size-11 items-center justify-center rounded-full text-muted-foreground hover:bg-primary/10 hover:text-foreground disabled:opacity-30"><Check className="size-4" /></button>
        <button onClick={onCancelEdit} title="取消" className="fluid-press fluid-icon-press flex size-11 items-center justify-center rounded-full text-muted-foreground hover:bg-primary/10 hover:text-foreground"><X className="size-4" /></button>
      </>
    )
  }
  return (
    <>
      <button onClick={onStartEdit} disabled={isLoading} title="编辑" className="fluid-press fluid-icon-press flex size-11 items-center justify-center rounded-full text-muted-foreground hover:bg-primary/10 hover:text-foreground disabled:opacity-30"><Pencil className="size-4" /></button>
      <button onClick={onRegenerate} disabled={isLoading} title="从这里重新回复" className="fluid-press fluid-icon-press flex size-11 items-center justify-center rounded-full text-muted-foreground hover:bg-primary/10 hover:text-foreground disabled:opacity-30"><RefreshCw className="size-4" /></button>
    </>
  )
}
