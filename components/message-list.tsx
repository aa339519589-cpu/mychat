"use client"

import { useEffect, useMemo, useState } from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"

import { AssistantMessage } from "@/components/messages/assistant-message"
import { UserMessage } from "@/components/messages/user-message"
import type { Conversation, Message } from "@/lib/chat-data"
import { UI_SPRING, transitionFor } from "@/components/motion/fluid"

const INITIAL_RENDER_COUNT = 70
const RENDER_STEP = 50

export type MessageListProps = {
  conversation: Conversation
  onRegenerate?: () => void
  onEditUserMessage?: (messageId: string, content: string) => void
  onRegenerateFromUser?: (messageId: string) => void
  isLoading?: boolean
  onOpenArtifact?: (messageId: string) => void
  openArtifactId?: string | null
}

export function MessageList({
  conversation,
  onRegenerate,
  onEditUserMessage,
  onRegenerateFromUser,
  isLoading,
  onOpenArtifact,
  openArtifactId,
}: MessageListProps) {
  const messages = conversation.messages
  const lastAssistantIndex = [...messages]
    .map((message, index) => ({ message, index }))
    .reverse()
    .find(({ message }) => message.role === "assistant")?.index ?? -1
  const [activeUserId, setActiveUserId] = useState<string | null>(null)
  const [editingUserId, setEditingUserId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState("")
  const [visibleCount, setVisibleCount] = useState(INITIAL_RENDER_COUNT)
  const reducedMotion = useReducedMotion()

  useEffect(() => {
    setVisibleCount(INITIAL_RENDER_COUNT)
    setActiveUserId(null)
    setEditingUserId(null)
    setEditDraft("")
  }, [conversation.id])

  const visibleStart = Math.max(0, messages.length - visibleCount)
  const hiddenCount = visibleStart
  const visibleEntries = useMemo(
    () => messages
      .map((message, index) => ({ message, index }))
      .slice(visibleStart),
    [messages, visibleStart],
  )

  function startEdit(message: Message) {
    if (isLoading) return
    setActiveUserId(message.id)
    setEditingUserId(message.id)
    setEditDraft(message.content)
  }

  function cancelEdit() {
    setEditingUserId(null)
    setEditDraft("")
  }

  function commitEdit() {
    if (!editingUserId) return
    const text = editDraft.trim()
    if (!text) return
    onEditUserMessage?.(editingUserId, text)
    setEditingUserId(null)
    setEditDraft("")
  }

  return (
    <article className="mx-auto w-full min-w-0 max-w-[58rem] overflow-x-clip px-3 py-5 sm:px-4 md:px-8 md:py-6">
      <div className="min-w-0 space-y-6 md:space-y-8">
        {hiddenCount > 0 && (
          <div className="flex justify-center">
            <button
              onClick={() => setVisibleCount(value => Math.min(messages.length, value + RENDER_STEP))}
              className="fluid-press min-h-11 rounded-full border border-border/40 bg-muted/20 px-4 py-2 text-xs text-muted-foreground hover:bg-muted/35 hover:text-foreground"
            >
              显示更早的 {Math.min(hiddenCount, RENDER_STEP)} 条
            </button>
          </div>
        )}

        <AnimatePresence initial={false}>
        {visibleEntries.map(({ message, index }) => (
          <MessageEntry
            key={message.id}
            message={message}
            index={index}
            lastAssistantIndex={lastAssistantIndex}
            reducedMotion={reducedMotion}
            active={activeUserId === message.id}
            editing={editingUserId === message.id}
            editDraft={editDraft}
            isLoading={!!isLoading}
            onToggleActive={() => setActiveUserId(
              activeUserId === message.id ? null : message.id,
            )}
            onStartEdit={() => startEdit(message)}
            onEditDraft={setEditDraft}
            onCancelEdit={cancelEdit}
            onCommitEdit={commitEdit}
            onRegenerateUser={() => onRegenerateFromUser?.(message.id)}
            onOpenArtifact={onOpenArtifact}
            openArtifactId={openArtifactId}
            onRegenerateAssistant={onRegenerate}
          />
        ))}
        </AnimatePresence>
      </div>
    </article>
  )
}

type MessageEntryProps = {
  message: Message
  index: number
  lastAssistantIndex: number
  reducedMotion: boolean | null
  active: boolean
  editing: boolean
  editDraft: string
  isLoading: boolean
  onToggleActive: () => void
  onStartEdit: () => void
  onEditDraft: (value: string) => void
  onCancelEdit: () => void
  onCommitEdit: () => void
  onRegenerateUser: () => void
  openArtifactId?: string | null
  onOpenArtifact?: (messageId: string) => void
  onRegenerateAssistant?: () => void
}

function MessageEntry({
  message,
  index,
  lastAssistantIndex,
  reducedMotion,
  active,
  editing,
  editDraft,
  isLoading,
  onToggleActive,
  onStartEdit,
  onEditDraft,
  onCancelEdit,
  onCommitEdit,
  onRegenerateUser,
  openArtifactId,
  onOpenArtifact,
  onRegenerateAssistant,
}: MessageEntryProps) {
  return (
    <motion.div
      initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.99 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.99 }}
      transition={transitionFor(reducedMotion, UI_SPRING)}
    >
      {message.role === "user" ? (
        <UserMessage
          message={message}
          active={active}
          editing={editing}
          editDraft={editDraft}
          isLoading={isLoading}
          onToggleActive={onToggleActive}
          onStartEdit={onStartEdit}
          onEditDraft={onEditDraft}
          onCancelEdit={onCancelEdit}
          onCommitEdit={onCommitEdit}
          onRegenerate={onRegenerateUser}
        />
      ) : (
        <AssistantMessage
          message={message}
          isLast={index === lastAssistantIndex}
          isLoading={isLoading}
          openArtifactId={openArtifactId}
          onOpenArtifact={onOpenArtifact}
          onRegenerate={onRegenerateAssistant}
        />
      )}
    </motion.div>
  )
}
