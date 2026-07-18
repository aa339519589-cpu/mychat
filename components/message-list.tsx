"use client"

import { memo, useEffect, useMemo, useState } from "react"

import { AssistantMessage } from "@/components/messages/assistant-message"
import { UserMessage } from "@/components/messages/user-message"
import { useMessageListController } from "@/components/message-list/use-message-list-controller"
import type { Conversation, Message } from "@/lib/chat-data"

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

export function MessageList(props: MessageListProps) {
  const { conversation, isLoading, openArtifactId } = props
  const messages = conversation.messages
  const [visibleCount, setVisibleCount] = useState(INITIAL_RENDER_COUNT)
  const controller = useMessageListController({
    conversationId: conversation.id,
    isLoading: !!isLoading,
    handlers: props,
  })

  useEffect(() => {
    setVisibleCount(INITIAL_RENDER_COUNT)
  }, [conversation.id])

  const lastAssistantId = useMemo(() => findLastAssistantId(messages), [messages])
  const visibleStart = Math.max(0, messages.length - visibleCount)
  const visibleMessages = useMemo(
    () => messages.slice(visibleStart),
    [messages, visibleStart],
  )

  return (
    <article className="mx-auto w-full min-w-0 max-w-[58rem] overflow-x-clip px-3 py-5 sm:px-4 md:px-8 md:py-6">
      <div className="min-w-0 space-y-6 md:space-y-8">
        {visibleStart > 0 && (
          <div className="flex justify-center">
            <button
              onClick={() => setVisibleCount(value => Math.min(messages.length, value + RENDER_STEP))}
              className="fluid-press min-h-11 rounded-full border border-border/40 bg-muted/20 px-4 py-2 text-xs text-muted-foreground hover:bg-muted/35 hover:text-foreground"
            >
              显示更早的 {Math.min(visibleStart, RENDER_STEP)} 条
            </button>
          </div>
        )}
        <MessageRows
          messages={visibleMessages}
          lastAssistantId={lastAssistantId}
          isLoading={!!isLoading}
          openArtifactId={openArtifactId}
          canOpenArtifact={!!props.onOpenArtifact}
          canRegenerateAssistant={!!props.onRegenerate}
          controller={controller}
        />
      </div>
    </article>
  )
}

function findLastAssistantId(messages: Message[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") return messages[index].id
  }
  return null
}

type MessageController = ReturnType<typeof useMessageListController>

function MessageRows({
  messages,
  lastAssistantId,
  isLoading,
  openArtifactId,
  canOpenArtifact,
  canRegenerateAssistant,
  controller,
}: {
  messages: Message[]
  lastAssistantId: string | null
  isLoading: boolean
  openArtifactId?: string | null
  canOpenArtifact: boolean
  canRegenerateAssistant: boolean
  controller: MessageController
}) {
  return messages.map(message => (
    <MessageEntry
      key={message.id}
      message={message}
      isLastAssistant={message.id === lastAssistantId}
      active={controller.activeUserId === message.id}
      editing={controller.editingUserId === message.id}
      editDraft={controller.editingUserId === message.id ? controller.editDraft : ""}
      isLoading={isLoading}
      onToggleActive={controller.toggleActive}
      onStartEdit={controller.startEdit}
      onEditDraft={controller.updateEditDraft}
      onCancelEdit={controller.cancelEdit}
      onCommitEdit={controller.commitEdit}
      onRegenerateUser={controller.regenerateFromUser}
      onOpenArtifact={canOpenArtifact ? controller.openArtifact : undefined}
      openArtifactId={openArtifactId}
      onRegenerateAssistant={canRegenerateAssistant ? controller.regenerateAssistant : undefined}
    />
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

const MessageEntry = memo(function MessageEntry({
  message,
  isLastAssistant,
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
    <div className="message-entry">
      {message.role === "user" ? (
        <UserMessage
          message={message}
          active={active}
          editing={editing}
          editDraft={editDraft}
          isLoading={isLoading}
          onToggleActive={() => onToggleActive(message.id)}
          onStartEdit={() => onStartEdit(message)}
          onEditDraft={onEditDraft}
          onCancelEdit={onCancelEdit}
          onCommitEdit={onCommitEdit}
          onRegenerate={() => onRegenerateUser(message.id)}
        />
      ) : (
        <AssistantMessage
          message={message}
          isLast={isLastAssistant}
          isLoading={isLoading}
          openArtifactId={openArtifactId}
          onOpenArtifact={onOpenArtifact}
          onRegenerate={onRegenerateAssistant}
        />
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
