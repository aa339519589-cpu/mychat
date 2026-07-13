import type { Dispatch, SetStateAction } from "react"
import type { Conversation, Tier } from "@/lib/chat-data"
import type { AttachedFile } from "@/lib/file-extract"
import type { Memory } from "@/lib/memory-data"
import type { ModelEndpointSummary } from "@/lib/model-endpoints"
import type { ProjectContext } from "@/lib/project-data"
import type { SearchMode } from "@/lib/search-mode"
import type { ClientGenerationState } from "@/lib/generation-client"
import {
  conversationExcerpt,
  insertMessage,
  touchConversation,
  updateMessageFields,
} from "@/lib/data"
import {
  MAX_GENERATED_MEDIA_ITEMS,
  normalizeGeneratedMedia,
  type GeneratedMedia,
} from "@/lib/generated-media"
import { planChatStreamFinalization } from "@/lib/chat-stream-finalization"
import { persistGeneratedMediaList } from "@/lib/media-storage"
import { parseSseEvent, splitSseEvents } from "./stream-events"

export type HistoryMessage = {
  id?: string
  role: string
  content: string
  images?: string[]
  imageSummary?: string
  ts?: string
}

type GenerationPatch = Partial<ClientGenerationState> & {
  status: ClientGenerationState["status"]
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
  markGeneration: (conversationId: string, patch: GenerationPatch) => void
  clearAbort: (conversationId: string, controller: AbortController) => void
}

export async function runChatStream(options: RunChatStreamOptions): Promise<string> {
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
  let aborted = false
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
      messages: conversation.messages.map(message => message.id !== assistantMessageId ? message : {
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

        if (data.generationId && data.assistantMessageId) {
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
    cancelScheduledRender()
    const hasOutput = !!fullReply || fullMedia.length > 0
    const finalization = planChatStreamFinalization({ hasOutput, aborted, terminalError })

    if (finalization.kind === "persist") {
      if (typeof window !== "undefined" && window.localStorage?.getItem("mychat_debug_md") === "1") {
        console.debug("[mychat/md] final markdown", JSON.stringify(fullReply))
      }
      const streamWarning = finalization.warning
      flushStreamMessage(streamWarning)
      try {
        let durableMedia = fullMedia
        if (fullMedia.length) {
          try {
            durableMedia = await persistGeneratedMediaList(userId, conversationId, fullMedia)
            console.info("[image-generation] message media durable", {
              conversationId,
              assistantMessageId,
              count: durableMedia.length,
              urls: durableMedia.map(media => media.url.slice(0, 80)),
            })
            setConversations(previous => previous.map(conversation => conversation.id !== conversationId ? conversation : {
              ...conversation,
              messages: conversation.messages.map(message => message.id === assistantMessageId ? { ...message, media: durableMedia } : message),
            }))
          } catch (error) {
            console.warn("[image-generation] durable store failed, keeping provider urls", error)
          }
        }
        try {
          await updateMessageFields(conversationId, assistantMessageId, {
            content: fullReply,
            thinking: fullThinking || null,
            media: durableMedia.length ? durableMedia : undefined,
          })
          console.info("[image-generation] message persisted", {
            conversationId,
            assistantMessageId,
            contentLen: fullReply.length,
            mediaCount: durableMedia.length,
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

    clearAbort(conversationId, controller)
    markGeneration(conversationId, {
      status: aborted ? "cancelled" : terminalError ? "error" : "completed",
      generationId,
      assistantMessageId,
    })
  }

  return fullReply
}
