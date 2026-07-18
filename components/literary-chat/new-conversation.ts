import type { Dispatch, MutableRefObject, SetStateAction } from "react"
import type { Conversation } from "@/lib/chat-data"

const EMPTY_DRAFT_TITLE = "未命名的篇章"

export function createDraft(id: string, projectId?: string): Conversation {
  return { id, title: EMPTY_DRAFT_TITLE, excerpt: "", date: "今日", messages: [], draft: true, projectId }
}

export function acknowledgeCreatedConversation(options: {
  id: string
  conversations: Conversation[]
  activeId: string
  draftIdRef: MutableRefObject<string | null>
  rootConversationIdRef: MutableRefObject<string | null>
  replaceConversation: (id: string | null) => void
}) {
  const pendingDraft = options.conversations.find(conversation => (
    conversation.draft && conversation.id !== options.id && conversation.messages.length === 0
  ))
  options.draftIdRef.current = pendingDraft?.id ?? null
  if (options.activeId !== options.id) return
  options.rootConversationIdRef.current = options.id
  options.replaceConversation(options.id)
}

export function openNewConversation(options: {
  authenticated: boolean
  conversations: Conversation[]
  draftIdRef: MutableRefObject<string | null>
  rootConversationIdRef: MutableRefObject<string | null>
  activationTokenRef: MutableRefObject<number>
  setConversations: Dispatch<SetStateAction<Conversation[]>>
  setActiveId: Dispatch<SetStateAction<string>>
  setHydratingConversationId: Dispatch<SetStateAction<string | null>>
  openConversation: (id: string | null) => void
  closeDrawer: () => void
  closeArtifact: () => void
}) {
  if (!options.authenticated) return
  options.closeDrawer()
  options.closeArtifact()
  const existingDraft = options.draftIdRef.current
    ? options.conversations.find(conversation => conversation.id === options.draftIdRef.current)
    : undefined
  const id = existingDraft?.messages.length === 0 ? existingDraft.id : crypto.randomUUID()
  if (!existingDraft || existingDraft.id !== id) {
    options.draftIdRef.current = id
    options.setConversations(previous => [createDraft(id), ...previous])
  }
  options.rootConversationIdRef.current = id
  options.openConversation(null)
  options.setActiveId(id)
  options.activationTokenRef.current += 1
  options.setHydratingConversationId(null)
}
