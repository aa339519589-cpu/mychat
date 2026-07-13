import type { Dispatch, SetStateAction } from "react"
import type { Conversation } from "@/lib/chat-data"
import type { ClientGenerationPatch, ClientGenerationState } from "@/lib/generation-client"
import type { GenerationTerminalSnapshot } from "@/lib/generation/types"
import {
  cacheGenerationTerminal,
  conversationExcerpt,
  insertMessage,
  touchConversation,
  updateMessageFields,
} from "@/lib/data"
import type { GeneratedMedia } from "@/lib/generated-media"
import { generationTerminalWarning } from "@/lib/generation-message"
import { planChatStreamFinalization } from "@/lib/chat-stream-finalization"

export async function finalizeChatStream(options: {
  userId: string
  conversationId: string
  assistantMessageId: string
  controller: AbortController
  generationId?: string
  fullReply: string
  fullThinking: string
  fullMedia: GeneratedMedia[]
  terminalError: string | null
  authoritativeTerminal: GenerationTerminalSnapshot | null
  terminalProtocolExpected: boolean
  aborted: boolean
  setConversations: Dispatch<SetStateAction<Conversation[]>>
  markGeneration: (conversationId: string, patch: ClientGenerationPatch) => void
  clearAbort: (conversationId: string, controller: AbortController) => void
  flushStreamMessage: (warning?: string) => void
}): Promise<ClientGenerationState["status"]> {
  const {
    userId,
    conversationId,
    assistantMessageId,
    controller,
    generationId,
    fullReply,
    fullThinking,
    fullMedia,
    terminalError,
    authoritativeTerminal,
    terminalProtocolExpected,
    aborted,
    setConversations,
    markGeneration,
    clearAbort,
    flushStreamMessage,
  } = options
  const hasOutput = !!fullReply || fullMedia.length > 0
  const finalization = planChatStreamFinalization({ hasOutput, aborted, terminalError })
  const authoritativeTerminalMissing = terminalProtocolExpected && !authoritativeTerminal
  const cacheAuthoritativeTerminal = async (terminal: GenerationTerminalSnapshot) => {
    if (!generationId) return
    await cacheGenerationTerminal(conversationId, assistantMessageId, {
      ...terminal,
      generationId,
    }).catch(() => undefined)
  }

  if (authoritativeTerminal && authoritativeTerminal.status !== "completed") {
    const terminal = authoritativeTerminal
    setConversations(previous => previous.map(conversation => conversation.id !== conversationId ? conversation : {
      ...conversation,
      messages: conversation.messages.map(message => message.id !== assistantMessageId
        || (generationId
          && message.generation?.id === generationId
          && message.generation.sequence >= terminal.sequence) ? message : {
        ...message,
        content: terminal.content,
        thinking: terminal.thinking || undefined,
        media: undefined,
        isError: terminal.status === "failed" ? true : undefined,
        generation: generationId ? {
          id: generationId,
          status: terminal.status,
          sequence: terminal.sequence,
          error: terminal.error,
        } : undefined,
        outputWarning: generationId ? generationTerminalWarning({
          id: generationId,
          status: terminal.status,
          sequence: terminal.sequence,
          error: terminal.error,
        }) : undefined,
      }),
    }))
    await cacheAuthoritativeTerminal(terminal)
  } else if (authoritativeTerminalMissing) {
    setConversations(previous => previous.map(conversation => conversation.id !== conversationId ? conversation : {
      ...conversation,
      messages: conversation.messages.map(message => message.id !== assistantMessageId
        || (generationId && message.generation?.id === generationId) ? message : {
        ...message,
        content: "生成终态尚未确认，请重新载入会话",
        thinking: undefined,
        media: undefined,
        isError: true,
        outputWarning: terminalError || "生成终态尚未确认，请重新载入会话",
      }),
    }))
  } else if (authoritativeTerminal?.status === "completed" || finalization.kind === "persist") {
    if (typeof window !== "undefined" && window.localStorage?.getItem("mychat_debug_md") === "1") {
      console.debug("[mychat/md] final markdown", JSON.stringify(fullReply))
    }
    const streamWarning = authoritativeTerminal ? undefined : finalization.kind === "persist"
      ? finalization.warning
      : undefined
    flushStreamMessage(streamWarning)
    const durableMedia = authoritativeTerminal?.status === "completed"
      ? authoritativeTerminal.media
      : fullMedia
    if (authoritativeTerminal?.status === "completed") {
      await cacheAuthoritativeTerminal(authoritativeTerminal)
      setConversations(previous => previous.map(conversation => conversation.id === conversationId
        ? {
          ...conversation,
          excerpt: conversationExcerpt(fullReply),
          date: "今日",
          messages: conversation.messages.map(message => message.id !== assistantMessageId || !generationId
            ? message
            : {
              ...message,
              generation: {
                id: generationId,
                status: "completed",
                sequence: authoritativeTerminal.sequence,
                error: authoritativeTerminal.error,
              },
            }),
        }
        : conversation))
    } else {
      try {
        try {
          await updateMessageFields(conversationId, assistantMessageId, {
            content: fullReply,
            thinking: fullThinking || null,
            media: durableMedia.length ? durableMedia : undefined,
          })
        } catch {
          await insertMessage(userId, conversationId, {
            id: assistantMessageId,
            role: "assistant",
            content: fullReply,
            thinking: fullThinking || undefined,
            media: durableMedia.length ? durableMedia : undefined,
            time: "",
          })
        }
        await touchConversation(conversationId)
        setConversations(previous => previous.map(conversation => conversation.id === conversationId
          ? { ...conversation, excerpt: conversationExcerpt(fullReply), date: "今日" }
          : conversation))
      } catch {
        const warning = streamWarning
          ? `${streamWarning} 部分结果未能保存，请先下载媒体或复制内容后重试。`
          : "结果已生成，但未能保存。请先下载媒体或复制内容，然后检查网络后重试。"
        flushStreamMessage(warning)
      }
    }
  } else if (finalization.kind === "remove") {
    setConversations(previous => previous.map(conversation => conversation.id !== conversationId ? conversation : {
      ...conversation,
      messages: conversation.messages.filter(message => message.id !== assistantMessageId),
    }))
  } else {
    setConversations(previous => previous.map(conversation => conversation.id !== conversationId ? conversation : {
      ...conversation,
      messages: conversation.messages.map(message => message.id !== assistantMessageId ? message : {
        ...message,
        content: finalization.message,
        thinking: fullThinking || undefined,
        isError: true,
        outputWarning: undefined,
      }),
    }))
  }

  const status: ClientGenerationState["status"] = authoritativeTerminal
    ? authoritativeTerminal.status === "completed"
      ? "completed"
      : authoritativeTerminal.status === "cancelled"
        ? "cancelled"
        : "error"
    : authoritativeTerminalMissing
      ? "error"
      : aborted
        ? "cancelled"
        : terminalError
          ? "error"
          : "completed"
  clearAbort(conversationId, controller)
  markGeneration(conversationId, {
    status,
    generationId,
    assistantMessageId,
    authoritativeTerminal: Boolean(authoritativeTerminal),
  })
  return status
}
