import type { Dispatch, SetStateAction } from "react"
import type { Conversation, Tier } from "@/lib/chat-data"
import type { AttachedFile } from "@/lib/file-extract"
import type { Memory } from "@/lib/memory-data"
import type { ModelEndpointSummary } from "@/lib/model-endpoints"
import type { ProjectContext } from "@/lib/project-data"
import type { SearchMode } from "@/lib/search-mode"
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
import { parseSseEvent, splitSseEvents } from "./stream-events"
import { takeAcknowledgedGenerationTerminal } from "./generation-terminal-registry"
import { finalizeChatStream } from "./chat-stream-finalizer"

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
    const response = await fetch("/api/chat", {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
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
        generationId,
        assistantMessageId,
        generateImage: !endpointId && tier === "绘影",
        generateVideo: !endpointId && tier === "录像",
      }),
    })

    if (!response.ok) {
      const error = await response.json().catch(() => null)
      throw new Error(error?.error ?? `请求失败（${response.status}）`)
    }
    if (!response.body) throw new Error("无响应体")

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    streamLoop: while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const split = splitSseEvents(buffer + decoder.decode(value, { stream: true }))
      buffer = split.rest

      for (const eventText of split.events) {
        const event = parseSseEvent(eventText)
        if (!event || event.kind === "done") continue
        const data = event.data as Record<string, any>

        if ("terminal" in data) {
          if (!isGenerationTerminalSnapshot(data.terminal)) {
            terminalError = "生成终态响应无效，请重新载入会话"
            cancelScheduledRender()
            await reader.cancel().catch(() => undefined)
            break streamLoop
          }
          authoritativeTerminal = data.terminal
          fullReply = authoritativeTerminal.content
          fullThinking = authoritativeTerminal.thinking
          fullMedia.splice(0, fullMedia.length, ...authoritativeTerminal.media)
          cancelScheduledRender()
          continue
        }

        if (data.generationId && data.assistantMessageId) {
          terminalProtocolExpected = true
          markGeneration(conversationId, {
            status: "running",
            generationId: data.generationId,
            assistantMessageId: data.assistantMessageId,
          })
        }
        if (data.memory) {
          const memory = data.memory
          const note = memory.action === "create"
            ? (memory.ok ? `记住了：${memory.content}` : "记忆保存失败")
            : memory.action === "update"
              ? (memory.ok ? `更新了记忆：${memory.content}` : "记忆更新失败")
              : (memory.ok ? "忘记了一条记忆" : "记忆删除失败")
          setConversations(previous => previous.map(conversation => conversation.id !== conversationId ? conversation : {
            ...conversation,
            messages: conversation.messages.map(message => message.id !== assistantMessageId ? message : {
              ...message,
              memoryNotes: [...(message.memoryNotes ?? []), note],
            }),
          }))
          if (memory.ok && !projectContext) {
            if (memory.action === "create" && memory.id) {
              setMemories(previous => [...previous, { id: memory.id, content: memory.content ?? "", timestamp: memory.timestamp }])
            } else if (memory.action === "update" && memory.id) {
              setMemories(previous => previous.map(item => item.id === memory.id
                ? { ...item, content: memory.content ?? item.content, timestamp: memory.timestamp ?? item.timestamp }
                : item))
            } else if (memory.action === "delete" && memory.id) {
              setMemories(previous => previous.filter(item => item.id !== memory.id))
            }
          }
          continue
        }
        if (data.search) {
          setConversations(previous => previous.map(conversation => conversation.id !== conversationId ? conversation : {
            ...conversation,
            messages: conversation.messages.map(message => message.id !== assistantMessageId ? message : {
              ...message,
              searchNotes: [...(message.searchNotes ?? []), data.search],
            }),
          }))
          continue
        }
        if (data.imageSummary) {
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
          await reader.cancel().catch(() => undefined)
          break streamLoop
        }
        if (data.text) {
          if (typeof window !== "undefined" && window.localStorage?.getItem("mychat_debug_md") === "1") {
            console.debug("[mychat/md] stream delta", JSON.stringify(data.text))
          }
          fullReply += data.text
          scheduleStreamMessage()
        }
        if (data.thinking) {
          fullThinking += data.thinking
          scheduleStreamMessage()
        }
      }
    }
  } catch (error: any) {
    if (error?.name === "AbortError" || controller.signal.aborted) aborted = true
    else terminalError = error?.message ?? String(error)
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
