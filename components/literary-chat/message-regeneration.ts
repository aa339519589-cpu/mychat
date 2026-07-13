import type { Dispatch, SetStateAction } from "react"
import type { User } from "@supabase/supabase-js"
import type { Conversation, Message } from "@/lib/chat-data"
import type { AttachedFile } from "@/lib/file-extract"
import type { ClientGenerationState } from "@/lib/generation-client"
import type { ProjectContext } from "@/lib/project-data"
import {
  cacheConversationMessages,
  deleteMessageRow,
  deleteMessageRows,
  insertMessage,
  updateMessageContent,
} from "@/lib/data"
import type { HistoryMessage } from "./chat-stream-service"
import { toHistoryMessage } from "./message-history"

type GenerationPatch = Partial<ClientGenerationState> & {
  status: ClientGenerationState["status"]
}

type StartStream = (
  history: HistoryMessage[],
  assistantMessageId: string,
  conversationId: string,
  controller: AbortController,
  attachments?: AttachedFile[],
  projectContext?: ProjectContext,
  generationId?: string,
) => Promise<string>

type RegenerationContext = {
  user: User | null
  active: Conversation | undefined
  activeId: string
  isActiveGenerating: boolean
  setOpenArtifactId: Dispatch<SetStateAction<string | null>>
  setConversations: Dispatch<SetStateAction<Conversation[]>>
  markGeneration: (conversationId: string, patch: GenerationPatch) => void
  getProjectContext: (projectId?: string | null) => Promise<ProjectContext | undefined>
  registerAbort: (conversationId: string, controller: AbortController) => void
  startStream: StartStream
}

export async function regenerateLastAssistant(context: RegenerationContext) {
  const {
    user,
    active,
    activeId,
    isActiveGenerating,
    setOpenArtifactId,
    setConversations,
    markGeneration,
    getProjectContext,
    registerAbort,
    startStream,
  } = context
  if (!user || !active || isActiveGenerating) return
  setOpenArtifactId(null)
  const messages = active.messages
  const lastAssistantIndex = [...messages]
    .map((message, index) => ({ message, index }))
    .reverse()
    .find(({ message }) => message.role === "assistant")?.index ?? -1
  if (lastAssistantIndex === -1) return
  const lastAssistantMessage = messages[lastAssistantIndex]
  const history = messages.slice(0, lastAssistantIndex).map(toHistoryMessage)
  const assistantMessageId = crypto.randomUUID()
  let oldReplyDeleted = false
  const generationId = crypto.randomUUID()
  markGeneration(activeId, { status: "running", generationId, assistantMessageId })

  try {
    const projectContext = await getProjectContext(active.projectId)
    await deleteMessageRow(lastAssistantMessage.id)
    oldReplyDeleted = true
    const retainedMessages = messages.slice(0, lastAssistantIndex)
    cacheConversationMessages(activeId, retainedMessages)
    const replacement: Message = { id: assistantMessageId, role: "assistant", content: "", thinking: "", time: "此刻" }
    setConversations(previous => previous.map(conversation => conversation.id !== activeId ? conversation : {
      ...conversation,
      messages: [...retainedMessages, replacement],
    }))
    await insertMessage(user.id, activeId, replacement).catch(() => {})
    const controller = new AbortController()
    registerAbort(activeId, controller)
    await startStream(history, assistantMessageId, activeId, controller, undefined, projectContext, generationId)
  } catch (error) {
    console.error("handleRegenerate failed", error)
    let restored = !oldReplyDeleted
    if (oldReplyDeleted) {
      try {
        await insertMessage(user.id, activeId, lastAssistantMessage)
        cacheConversationMessages(activeId, messages)
        restored = true
      } catch {
        restored = false
      }
    }
    markGeneration(activeId, { status: "error", generationId, assistantMessageId })
    setConversations(previous => previous.map(conversation => conversation.id !== activeId ? conversation : {
      ...conversation,
      messages: restored
        ? messages.map(message => message.id === lastAssistantMessage.id
          ? { ...message, outputWarning: "无法开始重新生成，原回复已保留。请检查网络后重试。" }
          : message)
        : conversation.messages.map(message => message.id === assistantMessageId
          ? { ...message, content: "重新生成失败，且原回复未能恢复。请刷新页面检查历史记录。", isError: true }
          : message),
    }))
  }
}

export async function regenerateFromUser(context: RegenerationContext & {
  userMessageId: string
  editedContent?: string
}) {
  const {
    user,
    active,
    isActiveGenerating,
    setOpenArtifactId,
    setConversations,
    markGeneration,
    getProjectContext,
    registerAbort,
    startStream,
    userMessageId,
    editedContent,
  } = context
  if (!user || !active || isActiveGenerating) return
  setOpenArtifactId(null)
  const conversationId = active.id
  const messages = active.messages
  const userIndex = messages.findIndex(message => message.id === userMessageId && message.role === "user")
  if (userIndex === -1) return

  const sourceUser = messages[userIndex]
  const nextContent = (editedContent ?? sourceUser.content).trim()
  if (!nextContent) return
  const nextUser: Message = { ...sourceUser, content: nextContent, ts: sourceUser.ts ?? new Date().toISOString() }
  const removed = messages.slice(userIndex + 1)
  const assistantMessageId = crypto.randomUUID()
  const assistantMessage: Message = { id: assistantMessageId, role: "assistant", content: "", thinking: "", time: "此刻" }
  const contentChanged = nextContent !== sourceUser.content.trim()
  let contentUpdated = false
  let branchDeleted = false
  const generationId = crypto.randomUUID()
  markGeneration(conversationId, { status: "running", generationId, assistantMessageId })

  try {
    const projectContext = await getProjectContext(active.projectId)
    if (contentChanged) {
      await updateMessageContent(conversationId, sourceUser.id, nextContent)
      contentUpdated = true
    }
    await deleteMessageRows(removed.map(message => message.id))
    branchDeleted = true
    const retainedMessages = [...messages.slice(0, userIndex), nextUser]
    cacheConversationMessages(conversationId, retainedMessages)
    setConversations(previous => previous.map(conversation => conversation.id !== conversationId ? conversation : {
      ...conversation,
      messages: [...retainedMessages, assistantMessage],
    }))
    await insertMessage(user.id, conversationId, assistantMessage).catch(() => {})
    const controller = new AbortController()
    registerAbort(conversationId, controller)
    await startStream(retainedMessages.map(toHistoryMessage), assistantMessageId, conversationId, controller, undefined, projectContext, generationId)
  } catch (error) {
    console.error("regenerateFromUserMessage failed", error)
    let restored = !branchDeleted
    if (branchDeleted) {
      try {
        if (contentUpdated) await updateMessageContent(conversationId, sourceUser.id, sourceUser.content)
        for (const message of removed) await insertMessage(user.id, conversationId, message)
        cacheConversationMessages(conversationId, messages)
        restored = true
      } catch {
        restored = false
      }
    }
    markGeneration(conversationId, { status: "error" })
    setConversations(previous => previous.map(conversation => conversation.id !== conversationId ? conversation : {
      ...conversation,
      messages: restored ? (() => {
        const warningTarget = [...removed].reverse().find(message => message.role === "assistant")?.id
        const restoredMessages = messages.map(message => message.id === sourceUser.id && contentUpdated && !branchDeleted
          ? { ...message, content: nextContent }
          : message.id === warningTarget
            ? { ...message, outputWarning: "无法开始重新回复，原有内容已保留。请检查网络后重试。" }
            : message)
        return warningTarget ? restoredMessages : [...restoredMessages, {
          id: assistantMessageId,
          role: "assistant" as const,
          content: "无法开始重新回复，请检查网络后重试。",
          time: "此刻",
          isError: true,
        }]
      })() : conversation.messages.map(message => message.id === assistantMessageId ? {
        ...message,
        content: "重新回复失败，且原有分支未能恢复。请刷新页面检查历史记录。",
        isError: true,
      } : message),
    }))
  }
}
