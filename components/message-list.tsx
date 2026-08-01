"use client"

import { memo, useEffect, useMemo, useRef, useState, type RefObject } from "react"

import { AssistantMessage } from "@/components/messages/assistant-message"
import { UserMessage } from "@/components/messages/user-message"
import { useMessageListController } from "@/components/message-list/use-message-list-controller"
import type { Conversation, Message } from "@/lib/chat-data"

const INITIAL_RENDER_COUNT = 70
const RENDER_STEP = 50
const MAX_SELECTED_TEXT_CHARS = 8_000
const ASK_SELECTED_TEXT_EVENT = "mychat:ask-selected-text"

type SelectionAction = { text: string; top: number; left: number }

export type MessageListProps = {
  conversation: Conversation
  onRegenerate?: () => void
  onEditUserMessage?: (messageId: string, content: string) => void
  onRegenerateFromUser?: (messageId: string) => void
  isLoading?: boolean
  onOpenArtifact?: (messageId: string) => void
  openArtifactId?: string | null
}

export function MessageList(props: MessageListProps) {
  const { conversation, isLoading, openArtifactId } = props
  const messages = conversation.messages
  const [visibleCount, setVisibleCount] = useState(INITIAL_RENDER_COUNT)
  const articleRef = useRef<HTMLElement>(null)
  const controller = useMessageListController({
    conversationId: conversation.id,
    isLoading: !!isLoading,
    handlers: props,
  })

  useEffect(() => { setVisibleCount(INITIAL_RENDER_COUNT) }, [conversation.id])

  const lastAssistantId = useMemo(() => findLastAssistantId(messages), [messages])
  const visibleStart = Math.max(0, messages.length - visibleCount)
  const visibleMessages = useMemo(() => messages.slice(visibleStart), [messages, visibleStart])

  return (
    <article ref={articleRef} className="mx-auto w-full min-w-0 max-w-[58rem] overflow-x-clip px-3 py-5 sm:px-4 md:px-8 md:py-6">
      <div className="min-w-0 space-y-6 md:space-y-8">
        {visibleStart > 0 && (
          <div className="flex justify-center">
            <button onClick={() => setVisibleCount(value => Math.min(messages.length, value + RENDER_STEP))} className="fluid-press min-h-11 rounded-full border border-border/40 bg-muted/20 px-4 py-2 text-xs text-muted-foreground hover:bg-muted/35 hover:text-foreground">
              显示更早的 {Math.min(visibleStart, RENDER_STEP)} 条
            </button>
          </div>
        )}
        <MessageRows messages={visibleMessages} lastAssistantId={lastAssistantId} isLoading={!!isLoading} openArtifactId={openArtifactId} canOpenArtifact={!!props.onOpenArtifact} canRegenerateAssistant={!!props.onRegenerate} controller={controller} />
      </div>
      <SelectedTextAction containerRef={articleRef} />
    </article>
  )
}

function selectedTextAction(container: HTMLElement | null): SelectionAction | null {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || !container || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  const common = range.commonAncestorContainer
  const commonElement = common.nodeType === Node.ELEMENT_NODE ? common : common.parentElement
  if (!commonElement || !container.contains(commonElement)) return null
  const text = selection.toString().trim().slice(0, MAX_SELECTED_TEXT_CHARS)
  if (!text) return null
  const rect = range.getBoundingClientRect()
  if (!rect.width && !rect.height) return null
  return {
    text,
    left: Math.min(window.innerWidth - 62, Math.max(62, rect.left + rect.width / 2)),
    top: Math.min(window.innerHeight - 56, Math.max(56, rect.bottom + 12)),
  }
}

function useSelectedTextAction(containerRef: RefObject<HTMLElement | null>) {
  const [action, setAction] = useState<SelectionAction | null>(null)
  useEffect(() => {
    const update = () => setAction(selectedTextAction(containerRef.current))
    const schedule = () => window.setTimeout(update, 0)
    document.addEventListener("selectionchange", schedule)
    window.addEventListener("resize", update)
    window.addEventListener("scroll", update, true)
    return () => {
      document.removeEventListener("selectionchange", schedule)
      window.removeEventListener("resize", update)
      window.removeEventListener("scroll", update, true)
    }
  }, [containerRef])
  return { action, clear: () => setAction(null) }
}

function SelectedTextAction({ containerRef }: { containerRef: RefObject<HTMLElement | null> }) {
  const selection = useSelectedTextAction(containerRef)
  if (!selection.action) return null
  const { text, left, top } = selection.action
  return (
    <button type="button" aria-label="引用选中文字询问模型" onPointerDown={event => event.preventDefault()} onClick={() => {
      window.dispatchEvent(new CustomEvent(ASK_SELECTED_TEXT_EVENT, { detail: { text } }))
      window.getSelection()?.removeAllRanges()
      selection.clear()
    }} className="fluid-press fixed z-[80] -translate-x-1/2 rounded-full border border-border/70 bg-popover px-4 py-2 text-sm font-medium text-popover-foreground shadow-xl backdrop-blur-md" style={{ left, top }}>
      询问模型
    </button>
  )
}

function findLastAssistantId(messages: Message[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") return messages[index].id
  }
  return null
}

type MessageController = ReturnType<typeof useMessageListController>

function MessageRows({ messages, lastAssistantId, isLoading, openArtifactId, canOpenArtifact, canRegenerateAssistant, controller }: {
  messages: Message[]
  lastAssistantId: string | null
  isLoading: boolean
  openArtifactId?: string | null
  canOpenArtifact: boolean
  canRegenerateAssistant: boolean
  controller: MessageController
}) {
  return messages.map(message => (
    <MessageEntry key={message.id} message={message} isLastAssistant={message.id === lastAssistantId} active={controller.activeUserId === message.id} editing={controller.editingUserId === message.id} editDraft={controller.editingUserId === message.id ? controller.editDraft : ""} isLoading={isLoading} onToggleActive={controller.toggleActive} onStartEdit={controller.startEdit} onEditDraft={controller.updateEditDraft} onCancelEdit={controller.cancelEdit} onCommitEdit={controller.commitEdit} onRegenerateUser={controller.regenerateFromUser} onOpenArtifact={canOpenArtifact ? controller.openArtifact : undefined} openArtifactId={openArtifactId} onRegenerateAssistant={canRegenerateAssistant ? controller.regenerateAssistant : undefined} />
  ))
}

type MessageEntryProps = {
  message: Message
  isLastAssistant: boolean
  active: boolean
  editing: boolean
  editDraft: string
  isLoading: boolean
  onToggleActive: (messageId: string) => void
  onStartEdit: (message: Message) => void
  onEditDraft: (value: string) => void
  onCancelEdit: () => void
  onCommitEdit: () => void
  onRegenerateUser: (messageId: string) => void
  openArtifactId?: string | null
  onOpenArtifact?: (messageId: string) => void
  onRegenerateAssistant?: () => void
}

const MessageEntry = memo(function MessageEntry({ message, isLastAssistant, active, editing, editDraft, isLoading, onToggleActive, onStartEdit, onEditDraft, onCancelEdit, onCommitEdit, onRegenerateUser, openArtifactId, onOpenArtifact, onRegenerateAssistant }: MessageEntryProps) {
  return (
    <div className="message-entry">
      {message.role === "user" ? (
        <UserMessage message={message} active={active} editing={editing} editDraft={editDraft} isLoading={isLoading} onToggleActive={() => onToggleActive(message.id)} onStartEdit={() => onStartEdit(message)} onEditDraft={onEditDraft} onCancelEdit={onCancelEdit} onCommitEdit={onCommitEdit} onRegenerate={() => onRegenerateUser(message.id)} />
      ) : (
        <AssistantMessage message={message} isLast={isLastAssistant} isLoading={isLoading} openArtifactId={openArtifactId} onOpenArtifact={onOpenArtifact} onRegenerate={onRegenerateAssistant} />
      )}
    </div>
  )
}, sameMessageEntry)

const MESSAGE_COMPARE_KEYS = [
  "id", "role", "content", "time", "ts", "isError", "outputWarning",
  "thinking", "images", "imageSummary", "media", "memoryNotes", "files",
  "searchNotes", "generation",
] as const satisfies readonly (keyof Message)[]

const ENTRY_COMPARE_KEYS = [
  "isLastAssistant", "active", "editing", "editDraft", "isLoading",
  "onToggleActive", "onStartEdit", "onEditDraft", "onCancelEdit",
  "onCommitEdit", "onRegenerateUser", "openArtifactId", "onOpenArtifact",
  "onRegenerateAssistant",
] as const satisfies readonly (keyof MessageEntryProps)[]

function sameMessageEntry(previous: MessageEntryProps, next: MessageEntryProps) {
  return sameMessage(previous.message, next.message)
    && ENTRY_COMPARE_KEYS.every(key => previous[key] === next[key])
}

function sameMessage(previous: Message, next: Message) {
  return previous === next
    || MESSAGE_COMPARE_KEYS.every(key => previous[key] === next[key])
}
