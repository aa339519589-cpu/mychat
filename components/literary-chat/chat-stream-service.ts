import type { Dispatch, SetStateAction } from "react"
import type { Conversation, Tier } from "@/lib/chat-data"
import type { AttachedFile } from "@/lib/file-extract"
import type { Memory } from "@/lib/memory-data"
import type { ModelEndpointSummary } from "@/lib/model-endpoints"
import type { ProjectContext } from "@/lib/project-data"
import type { SearchMode } from "@/lib/search-mode"
import { errorMessage, isRecord } from "@/lib/unknown-value"
import type { ClientGenerationPatch, ClientGenerationState } from "@/lib/generation-client"
import {
  isGenerationTerminalSnapshot,
  type GenerationTerminalSnapshot,
} from "@/lib/generation/types"
import {
  MAX_GENERATED_MEDIA_ITEMS,
  normalizeGeneratedMedia,
  type GeneratedMedia,
} from "@/lib/generated-media"
import { takeAcknowledgedGenerationTerminal } from "./generation-terminal-registry"
import { finalizeChatStream } from "./chat-stream-finalizer"
import { enqueueJob, streamJobEvents } from "./job-stream-client"

export type HistoryMessage = {
  id?: string
  role: string
  content: string
  images?: string[]
  imageSummary?: string
  ts?: string
}

export type RunChatStreamOptions = {
  userId: string
  messages: HistoryMessage[]
  assistantMessageId: string
  conversationId: string
  controller: AbortController
  attachments?: AttachedFile[]
  projectContext?: ProjectContext
  generationId?: string
  tier: Tier
  endpoint: ModelEndpointSummary | null
  endpointId: string | null
  memories: Memory[]
  memoryEnabled: boolean
  searchMode: SearchMode
  deepResearch: boolean
  historyRetrieval: boolean
  setConversations: Dispatch<SetStateAction<Conversation[]>>
  setMemories: Dispatch<SetStateAction<Memory[]>>
  markGeneration: (conversationId: string, patch: ClientGenerationPatch) => void
  clearAbort: (conversationId: string, controller: AbortController) => void
}

export type RunChatStreamResult = {
  content: string
  status: ClientGenerationState["status"]
}

export async function runChatStream(options: RunChatStreamOptions): Promise<RunChatStreamResult> {
  const {
    userId,
    messages,
    assistantMessageId,
    conversationId,
    controller,
    attachments,
    projectContext,
    generationId,
    tier,
    endpoint,
    endpointId,
    memories,
    memoryEnabled,
    searchMode,
    deepResearch,
    historyRetrieval,
    setConversations,
    setMemories,
    markGeneration,
    clearAbort,
  } = options

  markGeneration(conversationId, {
    status: "running",
    generationId,
    assistantMessageId,
  })

  let fullReply = ""
  let fullThinking = ""
  let terminalError: string | null = null
  let authoritativeTerminal: GenerationTerminalSnapshot | null = null
  let terminalProtocolExpected = false
  let aborted = false
  let finalStatus: ClientGenerationState["status"] = "error"
  const fullMedia: GeneratedMedia[] = []
  let renderScheduled = false
  let rafId: number | null = null

  const cancelScheduledRender = () => {
    if (rafId !== null) cancelAnimationFrame(rafId)
    renderScheduled = false
    rafId = null
  }

  const flushStreamMessage = (outputWarning?: string) => {
    renderScheduled = false
    rafId = null
    setConversations(previous => previous.map(conversation => conversation.id !== conversationId ? conversation : {
      ...conversation,
      messages: conversation.messages.map(message => message.id !== assistantMessageId
        || (generationId && message.generation?.id === generationId) ? message : {
        ...message,
        content: fullReply,
        thinking: fullThinking || undefined,
        media: fullMedia.length ? [...fullMedia] : undefined,
        isError: undefined,
        outputWarning,
      }),
    }))
  }

  const scheduleStreamMessage = () => {
    if (terminalError || aborted || renderScheduled) return
    renderScheduled = true
    rafId = requestAnimationFrame(() => flushStreamMessage())
  }

  try {
    const userMessageId = [...messages].reverse()
      .find(message => message.role === "user" && typeof message.id === "string")?.id
    const accepted = await enqueueJob("/api/chat", {
        tier,
        ...(endpoint ? { endpointId: endpoint.id } : {}),
        messages,
        memories: projectContext ? undefined : (memoryEnabled && memories.length > 0 ? memories : undefined),
        attachments: attachments?.length ? attachments : undefined,
        searchMode,
        deepResearch,
        historyRetrieval,
        project: projectContext,
        conversationId,
        ...(userMessageId ? { userMessageId } : {}),
        generationId,
        assistantMessageId,
        generateImage: !endpointId && tier === "绘影",
        generateVideo: !endpointId && tier === "录像",
      }, controller.signal)
    terminalProtocolExpected = true
    markGeneration(conversationId, {
      status: "running",
      generationId: accepted.jobId,
      assistantMessageId,
    })

    streamLoop: for await (const jobEvent of streamJobEvents(accepted, controller.signal)) {
        const data: Record<string, unknown> = jobEvent.payload

        if (jobEvent.kind === "job.retry_scheduled"
          || (jobEvent.kind === "job.leased" && typeof data.attempt === "number" && data.attempt > 1)) {
          fullReply = ""
          fullThinking = ""
          fullMedia.splice(0, fullMedia.length)
          cancelScheduledRender()
          flushStreamMessage()
          continue
        }

        if (jobEvent.kind === "job.terminal") {
          const result = isRecord(data.result) ? data.result : {}
          const status = data.status
          const terminal = {
            status,
            content: typeof result.content === "string" ? result.content : fullReply,
            thinking: typeof result.thinking === "string" ? result.thinking : fullThinking,
            sequence: jobEvent.seq,
            error: typeof data.errorCode === "string" ? data.errorCode : null,
            media: Array.isArray(result.media) ? result.media : [],
          }
          if (!isGenerationTerminalSnapshot(terminal)) {
            terminalError = "生成终态响应无效，请重新载入会话"
            cancelScheduledRender()
            break streamLoop
          }
          authoritativeTerminal = terminal
          fullReply = authoritativeTerminal.content
          fullThinking = authoritativeTerminal.thinking
          fullMedia.splice(0, fullMedia.length, ...authoritativeTerminal.media)
          cancelScheduledRender()
          continue
        }

        if (isRecord(data.memory)
          && (data.memory.action === "create" || data.memory.action === "update" || data.memory.action === "delete")
          && typeof data.memory.ok === "boolean") {
          const memory = data.memory
          const memoryId = typeof memory.id === "string" ? memory.id : undefined
          const memoryContent = typeof memory.content === "string" ? memory.content : undefined
          const memoryTimestamp = typeof memory.timestamp === "string" ? memory.timestamp : undefined
          const note = memory.action === "create"
            ? (memory.ok ? `记住了：${memoryContent ?? ""}` : "记忆保存失败")
            : memory.action === "update"
              ? (memory.ok ? `更新了记忆：${memoryContent ?? ""}` : "记忆更新失败")
              : (memory.ok ? "忘记了一条记忆" : "记忆删除失败")
          setConversations(previous => previous.map(conversation => conversation.id !== conversationId ? conversation : {
            ...conversation,
            messages: conversation.messages.map(message => message.id !== assistantMessageId ? message : {
              ...message,
              memoryNotes: [...(message.memoryNotes ?? []), note],
            }),
          }))
          if (memory.ok && !projectContext) {
            if (memory.action === "create" && memoryId) {
              setMemories(previous => [...previous, { id: memoryId, content: memoryContent ?? "", timestamp: memoryTimestamp }])
            } else if (memory.action === "update" && memoryId) {
              setMemories(previous => previous.map(item => item.id === memoryId
                ? { ...item, content: memoryContent ?? item.content, timestamp: memoryTimestamp ?? item.timestamp }
                : item))
            } else if (memory.action === "delete" && memoryId) {
              setMemories(previous => previous.filter(item => item.id !== memoryId))
            }
          }
          continue
        }
        if (isRecord(data.search) && typeof data.search.query === "string" && Array.isArray(data.search.results)) {
          const results = data.search.results.flatMap(result => isRecord(result)
            && typeof result.title === "string"
            && typeof result.url === "string"
            ? [{ title: result.title, url: result.url }]
            : [])
          const search = { query: data.search.query, results }
          setConversations(previous => previous.map(conversation => conversation.id !== conversationId ? conversation : {
            ...conversation,
            messages: conversation.messages.map(message => message.id !== assistantMessageId ? message : {
              ...message,
              searchNotes: [...(message.searchNotes ?? []), search],
            }),
          }))
          continue
        }
        if (isRecord(data.imageSummary)
          && typeof data.imageSummary.messageId === "string"
          && typeof data.imageSummary.summary === "string") {
          const { messageId, summary } = data.imageSummary
          setConversations(previous => previous.map(conversation => conversation.id !== conversationId ? conversation : {
            ...conversation,
            messages: conversation.messages.map(message => message.id === messageId ? { ...message, imageSummary: summary } : message),
          }))
          continue
        }
        if (data.media) {
          const media = normalizeGeneratedMedia(data.media)
          if (media
            && fullMedia.length < MAX_GENERATED_MEDIA_ITEMS
            && !fullMedia.some(item => item.type === media.type && item.url === media.url)) {
            fullMedia.push(media)
            scheduleStreamMessage()
          }
          continue
        }
        if (data.error) {
          terminalError = typeof data.error === "string" ? data.error : "模型生成失败"
          cancelScheduledRender()
          break streamLoop
        }
        if (typeof data.text === "string" && data.text) {
          if (typeof window !== "undefined" && window.localStorage?.getItem("mychat_debug_md") === "1") {
            console.debug("[mychat/md] stream delta", JSON.stringify(data.text))
          }
          fullReply += data.text
          scheduleStreamMessage()
        }
        if (typeof data.thinking === "string" && data.thinking) {
          fullThinking += data.thinking
          scheduleStreamMessage()
        }
    }
  } catch (error) {
    if ((isRecord(error) && error.name === "AbortError") || controller.signal.aborted) aborted = true
    else terminalError = errorMessage(error, "模型生成失败")
  } finally {
    const acknowledgedTerminal = generationId
      ? takeAcknowledgedGenerationTerminal(generationId)
      : null
    if (!authoritativeTerminal && acknowledgedTerminal) {
      authoritativeTerminal = acknowledgedTerminal
      fullReply = acknowledgedTerminal.content
      fullThinking = acknowledgedTerminal.thinking
      fullMedia.splice(0, fullMedia.length, ...acknowledgedTerminal.media)
    }
    cancelScheduledRender()
    finalStatus = await finalizeChatStream({
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
    })
  }

  return {
    content: finalStatus === "completed" ? fullReply : "",
    status: finalStatus,
  }
}
