"use client"

import { useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react"
import type { User } from "@supabase/supabase-js"
import type { Conversation, Message, Tier } from "@/lib/chat-data"
import type { AttachedFile } from "@/lib/file-extract"
import type { Memory } from "@/lib/memory-data"
import type { ModelEndpointSummary } from "@/lib/model-endpoints"
import type { ProjectContext } from "@/lib/project-data"
import type { SearchMode } from "@/lib/search-mode"
import type { ClientGenerationPatch, ClientGenerationState } from "@/lib/generation-client"
import { isRunning, reduceClientGenerationState } from "@/lib/generation-client"
import {
  updateConversationTitle,
} from "@/lib/data"
import type { ChatTurnAuthority } from '@/lib/llm/chat-request'
import {
  runChatStream,
  type HistoryMessage,
  type RunChatStreamResult,
} from "./chat-stream-service"
import { resumeConversationGeneration } from "./generation-api"
import { generateConversationTitle } from "./generation-job-actions"
import { cancelActiveGeneration } from "./generation-cancellation"
import { toHistoryMessage } from "./message-history"
import { regenerateFromUser, regenerateLastAssistant } from "./message-regeneration"

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
  authorityReady: boolean
  setActiveId: Dispatch<SetStateAction<string>>
  setConversations: Dispatch<SetStateAction<Conversation[]>>
  setMemories: Dispatch<SetStateAction<Memory[]>>
  setOpenArtifactId: Dispatch<SetStateAction<string | null>>
  loadedRef: MutableRefObject<Set<string>>
  draftIdRef: MutableRefObject<string | null>
  getProjectContext: (projectId?: string | null) => Promise<ProjectContext | undefined>
  onConversationCreated?: (id: string) => void
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
    authorityReady,
    setConversations,
    setMemories,
    setOpenArtifactId,
    loadedRef,
    draftIdRef,
    getProjectContext,
    onConversationCreated,
  } = options

  const [generationByConversation, setGenerationByConversation] = useState<Record<string, ClientGenerationState>>({})
  const generationRef = useRef(generationByConversation)
  generationRef.current = generationByConversation
  const abortByConversationRef = useRef<Map<string, AbortController>>(new Map())
  const resumeByConversationRef = useRef<Map<string, {
    operation: Promise<void>
    reconciled: Promise<boolean>
  }>>(new Map())

  const activeGeneration = activeId ? generationByConversation[activeId] : undefined
  const isActiveGenerating = isRunning(activeGeneration)

  function markGeneration(conversationId: string, patch: ClientGenerationPatch) {
    setGenerationByConversation(previous => reduceClientGenerationState(previous, conversationId, patch))
  }

  function clearAbort(conversationId: string, controller: AbortController) {
    if (abortByConversationRef.current.get(conversationId) === controller) {
      abortByConversationRef.current.delete(conversationId)
    }
  }

  function resumeGenerationIfNeeded(conversationId: string) {
    const activeController = abortByConversationRef.current.get(conversationId)
    if (activeController && !activeController.signal.aborted) return Promise.resolve(true)
    const existing = resumeByConversationRef.current.get(conversationId)
    if (existing) return existing.reconciled
    let resolveReconciled!: (available: boolean) => void
    const reconciled = new Promise<boolean>(resolve => { resolveReconciled = resolve })
    const operation = resumeConversationGeneration({
      conversationId,
      setConversations,
      markGeneration,
      registerAbort: (id, controller) => abortByConversationRef.current.set(id, controller),
      clearAbort,
      onReconciled: resolveReconciled,
    })
    const entry = { operation, reconciled }
    resumeByConversationRef.current.set(conversationId, entry)
    const cleanup = () => {
      if (resumeByConversationRef.current.get(conversationId) === entry) {
        resumeByConversationRef.current.delete(conversationId)
      }
    }
    void operation.then(cleanup, () => {
      resolveReconciled(false)
      cleanup()
    })
    return reconciled
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
    turn?: ChatTurnAuthority,
    onAccepted?: () => void,
  ) {
    if (!user) {
      markGeneration(conversationId, { status: "error", generationId, assistantMessageId })
      return { content: "", status: "error", accepted: false } satisfies RunChatStreamResult
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
      turn,
      onAccepted,
      setConversations,
      setMemories,
      markGeneration,
      clearAbort,
    })
  }

  async function handleStop() {
    if (!activeId) return
    await cancelActiveGeneration({
      conversationId: activeId,
      generation: generationRef.current[activeId],
      setConversations,
      markGeneration,
    })
  }

  async function handleSend(text: string, images?: string[], files?: AttachedFile[]) {
    if (!authorityReady || !user || !active) return

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
      ? { ...conversation, messages: [...conversation.messages, userMessage, assistantMessage] }
      : conversation))
    markGeneration(draftId, { status: "running", generationId, assistantMessageId, begin: true })

    const conversationId = draftId
    try {
      const turn: ChatTurnAuthority = {
        schemaVersion: 1,
        createConversation: wasDraft,
        title: active.title || '未命名的篇章',
        projectId: active.projectId ?? null,
      }
      const onAccepted = wasDraft ? () => {
        loadedRef.current.add(conversationId)
        draftIdRef.current = null
        setConversations(previous => previous.map(conversation => conversation.id === draftId
          ? { ...conversation, draft: false }
          : conversation))
        onConversationCreated?.(conversationId)
      } : undefined

      const history = [...baseHistory, userMessage].map(toHistoryMessage)
      const projectContext = await getProjectContext(active.projectId)
      const controller = new AbortController()
      abortByConversationRef.current.set(conversationId, controller)
      const result = await startStream(
        history, assistantMessageId, conversationId, controller,
        files?.length ? files : undefined, projectContext, generationId, turn, onAccepted,
      )

      if (isFirstExchange && result.status === "completed" && result.content) {
        if (activeEndpoint && activeEndpoint.outputKind !== "chat") {
          const title = text.trim().replace(/\s+/g, " ").slice(0, 14) || "媒体生成"
          setConversations(previous => previous.map(conversation => conversation.id === conversationId
            ? { ...conversation, title }
            : conversation))
          updateConversationTitle(conversationId, title)
        } else {
          generateTitle(conversationId, text, result.content)
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
      isActiveGenerating: !authorityReady || isActiveGenerating,
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
