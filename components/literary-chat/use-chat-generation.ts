"use client"

import { useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react"
import type { User } from "@supabase/supabase-js"
import type { Conversation, Message, Tier } from "@/lib/chat-data"
import type { AttachedFile } from "@/lib/file-extract"
import type { Memory } from "@/lib/memory-data"
import type { ModelEndpointSummary } from "@/lib/model-endpoints"
import type { ProjectContext } from "@/lib/project-data"
import type { SearchMode } from "@/lib/search-mode"
import type { ClientGenerationState } from "@/lib/generation-client"
import { isRunning } from "@/lib/generation-client"
import {
  insertConversation,
  insertMessage,
  updateConversationTitle,
} from "@/lib/data"
import { runChatStream, type HistoryMessage } from "./chat-stream-service"
import { generateConversationTitle, resumeConversationGeneration } from "./generation-api"
import { toHistoryMessage } from "./message-history"
import { regenerateFromUser, regenerateLastAssistant } from "./message-regeneration"

type GenerationPatch = Partial<ClientGenerationState> & {
  status: ClientGenerationState["status"]
}

type UseChatGenerationOptions = {
  user: User | null
  active: Conversation | undefined
  activeId: string
  activeTier: Tier
  activeEndpoint: ModelEndpointSummary | null
  activeEndpointId: string | null
  memories: Memory[]
  memoryEnabled: boolean
  searchMode: SearchMode
  deepResearch: boolean
  historyRetrieval: boolean
  setActiveId: Dispatch<SetStateAction<string>>
  setConversations: Dispatch<SetStateAction<Conversation[]>>
  setMemories: Dispatch<SetStateAction<Memory[]>>
  setOpenArtifactId: Dispatch<SetStateAction<string | null>>
  loadedRef: MutableRefObject<Set<string>>
  draftIdRef: MutableRefObject<string | null>
  getProjectContext: (projectId?: string | null) => Promise<ProjectContext | undefined>
}

export function useChatGeneration(options: UseChatGenerationOptions) {
  const {
    user,
    active,
    activeId,
    activeTier,
    activeEndpoint,
    activeEndpointId,
    memories,
    memoryEnabled,
    searchMode,
    deepResearch,
    historyRetrieval,
    setActiveId,
    setConversations,
    setMemories,
    setOpenArtifactId,
    loadedRef,
    draftIdRef,
    getProjectContext,
  } = options

  const [generationByConversation, setGenerationByConversation] = useState<Record<string, ClientGenerationState>>({})
  const generationRef = useRef(generationByConversation)
  generationRef.current = generationByConversation
  const abortByConversationRef = useRef<Map<string, AbortController>>(new Map())

  const activeGeneration = activeId ? generationByConversation[activeId] : undefined
  const isActiveGenerating = isRunning(activeGeneration)

  function markGeneration(conversationId: string, patch: GenerationPatch) {
    setGenerationByConversation(previous => ({
      ...previous,
      [conversationId]: {
        conversationId,
        status: patch.status,
        generationId: patch.generationId ?? previous[conversationId]?.generationId,
        assistantMessageId: patch.assistantMessageId ?? previous[conversationId]?.assistantMessageId,
      },
    }))
  }

  function clearAbort(conversationId: string, controller: AbortController) {
    if (abortByConversationRef.current.get(conversationId) === controller) {
      abortByConversationRef.current.delete(conversationId)
    }
  }

  function resumeGenerationIfNeeded(conversationId: string) {
    return resumeConversationGeneration({
      conversationId,
      setConversations,
      markGeneration,
      registerAbort: (id, controller) => abortByConversationRef.current.set(id, controller),
      clearAbort,
    })
  }

  function generateTitle(conversationId: string, userText: string, assistantText: string) {
    return generateConversationTitle({
      conversationId,
      userText,
      assistantText,
      endpoint: activeEndpoint,
      setConversations,
    })
  }
  async function startStream(
    history: HistoryMessage[],
    assistantMessageId: string,
    conversationId: string,
    controller: AbortController,
    attachments?: AttachedFile[],
    projectContext?: ProjectContext,
    generationId?: string,
  ) {
    if (!user) {
      markGeneration(conversationId, { status: "error", generationId, assistantMessageId })
      return ""
    }
    return runChatStream({
      userId: user.id,
      messages: history,
      assistantMessageId,
      conversationId,
      controller,
      attachments,
      projectContext,
      generationId,
      tier: activeTier,
      endpoint: activeEndpoint,
      endpointId: activeEndpointId,
      memories,
      memoryEnabled,
      searchMode,
      deepResearch,
      historyRetrieval,
      setConversations,
      setMemories,
      markGeneration,
      clearAbort,
    })
  }

  function handleStop() {
    if (!activeId) return
    const controller = abortByConversationRef.current.get(activeId)
    const generation = generationRef.current[activeId]
    controller?.abort()
    if (generation?.generationId) {
      fetch(`/api/generations/${generation.generationId}/cancel`, { method: "POST" }).catch(() => {})
    }
    markGeneration(activeId, { status: "cancelled" })
    console.info("[mychat/generation] task cancelled", {
      conversationId: activeId,
      generationId: generation?.generationId,
      assistantMessageId: generation?.assistantMessageId,
    })
  }

  async function handleSend(text: string, images?: string[], files?: AttachedFile[]) {
    if (!user || !active) return

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      time: "此刻",
      ts: new Date().toISOString(),
      images: images?.length ? images : undefined,
      files: files?.map(file => file.name),
    }
    const assistantMessageId = crypto.randomUUID()
    const assistantMessage: Message = {
      id: assistantMessageId,
      role: "assistant",
      content: "",
      thinking: "",
      time: "此刻",
    }
    const isFirstExchange = active.messages.length === 0
    const wasDraft = !!active.draft
    const draftId = active.id
    const baseHistory = active.messages
    const generationId = crypto.randomUUID()

    setConversations(previous => previous.map(conversation => conversation.id === draftId
      ? { ...conversation, draft: false, messages: [...conversation.messages, userMessage, assistantMessage] }
      : conversation))
    markGeneration(draftId, { status: "running", generationId, assistantMessageId })

    let conversationId = draftId
    try {
      if (wasDraft) {
        const realId = await insertConversation(user.id, "未命名的篇章", active.projectId ?? undefined)
        if (!realId) {
          setConversations(previous => previous.map(conversation => conversation.id === draftId ? {
            ...conversation,
            draft: true,
            messages: conversation.messages.map(message => message.id === assistantMessageId
              ? { ...message, content: "创建会话失败，请重试", isError: true }
              : message),
          } : conversation))
          markGeneration(draftId, { status: "error", generationId, assistantMessageId })
          return
        }
        conversationId = realId
        loadedRef.current.add(realId)
        draftIdRef.current = null
        setGenerationByConversation(previous => {
          const { [draftId]: _drop, ...rest } = previous
          return {
            ...rest,
            [realId]: { conversationId: realId, status: "running", generationId, assistantMessageId },
          }
        })
        setConversations(previous => previous.map(conversation => conversation.id === draftId
          ? { ...conversation, id: realId }
          : conversation))
        setActiveId(realId)
        await insertMessage(user.id, realId, userMessage)
        await insertMessage(user.id, realId, assistantMessage).catch(() => {})
      } else {
        await insertMessage(user.id, conversationId, userMessage)
        await insertMessage(user.id, conversationId, assistantMessage).catch(() => {})
      }

      const history = [...baseHistory, userMessage].map(toHistoryMessage)
      const projectContext = await getProjectContext(active.projectId)
      const controller = new AbortController()
      abortByConversationRef.current.set(conversationId, controller)
      const fullReply = await startStream(history, assistantMessageId, conversationId, controller, files?.length ? files : undefined, projectContext, generationId)

      if (isFirstExchange && fullReply) {
        if (activeEndpoint && activeEndpoint.outputKind !== "chat") {
          const title = text.trim().replace(/\s+/g, " ").slice(0, 14) || "媒体生成"
          setConversations(previous => previous.map(conversation => conversation.id === conversationId
            ? { ...conversation, title }
            : conversation))
          updateConversationTitle(conversationId, title)
        } else {
          generateTitle(conversationId, text, fullReply)
        }
      }
    } catch (error) {
      console.error("handleSend failed", error)
      markGeneration(conversationId, { status: "error", generationId, assistantMessageId })
      setConversations(previous => previous.map(conversation => conversation.id === conversationId ? {
        ...conversation,
        messages: conversation.messages.map(message => message.id === assistantMessageId
          ? { ...message, content: message.content || "发送失败，请重试", isError: true }
          : message),
      } : conversation))
    }
  }

  function regenerationContext() {
    return {
      user,
      active,
      activeId,
      isActiveGenerating,
      setOpenArtifactId,
      setConversations,
      markGeneration,
      getProjectContext,
      registerAbort: (conversationId: string, controller: AbortController) => {
        abortByConversationRef.current.set(conversationId, controller)
      },
      startStream,
    }
  }

  function handleRegenerate() {
    return regenerateLastAssistant(regenerationContext())
  }

  function regenerateFromUserMessage(userMessageId: string, editedContent?: string) {
    return regenerateFromUser({ ...regenerationContext(), userMessageId, editedContent })
  }
  return {
    generationByConversation,
    isActiveGenerating,
    handleStop,
    handleSend,
    handleRegenerate,
    handleEditUserMessage: (messageId: string, content: string) => regenerateFromUserMessage(messageId, content),
    handleRegenerateFromUser: (messageId: string) => regenerateFromUserMessage(messageId),
    resumeGenerationIfNeeded,
  }
}
