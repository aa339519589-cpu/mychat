import type { Dispatch, SetStateAction } from "react"
import type { User } from "@supabase/supabase-js"
import type { Conversation, Message } from "@/lib/chat-data"
import type { AttachedFile } from "@/lib/file-extract"
import type { ClientGenerationPatch } from "@/lib/generation-client"
import type { ChatTurnAuthority } from "@/lib/llm/chat-request"
import type { ProjectContext } from "@/lib/project-data"
import { cacheConversationMessages } from "@/lib/data"
import type { HistoryMessage, RunChatStreamResult } from "./chat-stream-service"
import { toHistoryMessage } from "./message-history"

type StartStream = (
  history: HistoryMessage[],
  assistantMessageId: string,
  conversationId: string,
  controller: AbortController,
  attachments?: AttachedFile[],
  projectContext?: ProjectContext,
  generationId?: string,
  turn?: ChatTurnAuthority,
  onAccepted?: () => void,
) => Promise<RunChatStreamResult>

type RegenerationContext = {
  user: User | null
  active: Conversation | undefined
  activeId: string
  isActiveGenerating: boolean
  setOpenArtifactId: Dispatch<SetStateAction<string | null>>
  setConversations: Dispatch<SetStateAction<Conversation[]>>
  markGeneration: (conversationId: string, patch: ClientGenerationPatch) => void
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
  const retainedMessages = messages.slice(0, lastAssistantIndex)
  const history = retainedMessages.map(toHistoryMessage)
  const assistantMessageId = crypto.randomUUID()
  const generationId = crypto.randomUUID()
  const replacement: Message = {
    id: assistantMessageId, role: "assistant", content: "", thinking: "", time: "此刻",
  }
  const authority: ChatTurnAuthority = {
    schemaVersion: 2,
    operation: 'replace-assistant',
    expectedTailMessageId: lastAssistantMessage.id,
    targetAssistantMessageId: lastAssistantMessage.id,
  }
  let accepted = false
  markGeneration(activeId, { status: "running", generationId, assistantMessageId, begin: true })

  try {
    const projectContext = await getProjectContext(active.projectId)
    const controller = new AbortController()
    registerAbort(activeId, controller)
    const result = await startStream(
      history, assistantMessageId, activeId, controller, undefined, projectContext, generationId,
      authority, () => {
        accepted = true
        cacheConversationMessages(activeId, [...retainedMessages, replacement])
        setConversations(previous => previous.map(conversation => conversation.id !== activeId ? conversation : {
          ...conversation,
          messages: [...retainedMessages, replacement],
        }))
      },
    )
    if (!result.accepted) throw new Error('regeneration_not_accepted')
  } catch (error) {
    if (!(error instanceof Error && error.message === 'regeneration_not_accepted')) {
      console.error("handleRegenerate failed", error)
    }
    markGeneration(activeId, { status: "error", generationId, assistantMessageId })
    setConversations(previous => previous.map(conversation => conversation.id !== activeId ? conversation : {
      ...conversation,
      messages: accepted
        ? conversation.messages.map(message => message.id === assistantMessageId
          ? { ...message, content: message.content || "重新生成失败，请重试。", isError: true }
          : message)
        : messages.map(message => message.id === lastAssistantMessage.id
          ? { ...message, outputWarning: "无法开始重新生成，原回复已保留。请检查网络后重试。" }
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
  const retainedMessages = [...messages.slice(0, userIndex), nextUser]
  const expectedTailMessageId = messages.at(-1)?.id ?? sourceUser.id
  const authority: ChatTurnAuthority = {
    schemaVersion: 2,
    operation: 'replace-from-user',
    expectedTailMessageId,
  }
  let accepted = false
  const generationId = crypto.randomUUID()
  markGeneration(conversationId, { status: "running", generationId, assistantMessageId, begin: true })

  try {
    const projectContext = await getProjectContext(active.projectId)
    const controller = new AbortController()
    registerAbort(conversationId, controller)
    const result = await startStream(
      retainedMessages.map(toHistoryMessage), assistantMessageId, conversationId, controller,
      undefined, projectContext, generationId, authority, () => {
        accepted = true
        const nextMessages = [...retainedMessages, assistantMessage]
        cacheConversationMessages(conversationId, nextMessages)
        setConversations(previous => previous.map(conversation => conversation.id !== conversationId ? conversation : {
          ...conversation,
          messages: nextMessages,
        }))
      },
    )
    if (!result.accepted) throw new Error('regeneration_not_accepted')
  } catch (error) {
    if (!(error instanceof Error && error.message === 'regeneration_not_accepted')) {
      console.error("regenerateFromUserMessage failed", error)
    }
    markGeneration(conversationId, { status: "error" })
    setConversations(previous => previous.map(conversation => conversation.id !== conversationId ? conversation : {
      ...conversation,
      messages: accepted ? conversation.messages.map(message => message.id === assistantMessageId ? {
        ...message,
        content: message.content || "重新回复失败，请重试。",
        isError: true,
      } : message) : (() => {
        const warningTarget = [...removed].reverse().find(message => message.role === "assistant")?.id
        const unchangedMessages = messages.map(message => message.id === warningTarget
            ? { ...message, outputWarning: "无法开始重新回复，原有内容已保留。请检查网络后重试。" }
            : message)
        return warningTarget ? unchangedMessages : [...unchangedMessages, {
          id: assistantMessageId,
          role: "assistant" as const,
          content: "无法开始重新回复，请检查网络后重试。",
          time: "此刻",
          isError: true,
        }]
      })(),
    }))
  }
}
