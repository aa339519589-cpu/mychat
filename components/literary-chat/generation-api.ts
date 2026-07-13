import type { Dispatch, SetStateAction } from "react"
import type { Conversation } from "@/lib/chat-data"
import type { ClientGenerationState } from "@/lib/generation-client"
import type { ModelEndpointSummary } from "@/lib/model-endpoints"
import { updateConversationTitle } from "@/lib/data"
import { parseSseEvent, splitSseEvents } from "./stream-events"

type GenerationPatch = Partial<ClientGenerationState> & {
  status: ClientGenerationState["status"]
}

type ConversationSetter = Dispatch<SetStateAction<Conversation[]>>

export async function resumeConversationGeneration(options: {
  conversationId: string
  setConversations: ConversationSetter
  markGeneration: (conversationId: string, patch: GenerationPatch) => void
  registerAbort: (conversationId: string, controller: AbortController) => void
  clearAbort: (conversationId: string, controller: AbortController) => void
}) {
  const { conversationId, setConversations, markGeneration, registerAbort, clearAbort } = options
  try {
    const response = await fetch(`/api/generations/running?conversationId=${encodeURIComponent(conversationId)}`)
    if (!response.ok) return
    const data = await response.json()
    const generations = Array.isArray(data.generations) ? data.generations : []
    const running = generations.find((generation: any) => generation.status === "running" || generation.status === "queued")
    if (!running) return

    markGeneration(conversationId, {
      status: "running",
      generationId: running.id,
      assistantMessageId: running.assistantMessageId,
    })
    if (running.assistantMessageId && (running.content || running.thinking)) {
      setConversations(previous => previous.map(conversation => conversation.id !== conversationId ? conversation : {
        ...conversation,
        messages: conversation.messages.map(message => message.id === running.assistantMessageId ? {
          ...message,
          content: running.content || message.content,
          thinking: running.thinking || message.thinking,
        } : message),
      }))
    }

    const controller = new AbortController()
    registerAbort(conversationId, controller)
    const afterSequence = running.sequence ?? 0
    console.info("[mychat/generation] task resumed", {
      conversationId,
      generationId: running.id,
      assistantMessageId: running.assistantMessageId,
      afterSequence,
    })
    const streamResponse = await fetch(`/api/generations/${running.id}/stream?afterSequence=${afterSequence}`, {
      signal: controller.signal,
    })
    if (!streamResponse.ok || !streamResponse.body) return

    const reader = streamResponse.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    let full = running.content || ""
    let thinking = running.thinking || ""
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const split = splitSseEvents(buffer + decoder.decode(value, { stream: true }))
      buffer = split.rest
      for (const eventText of split.events) {
        const event = parseSseEvent(eventText)
        if (!event || event.kind === "done") continue
        const streamEvent = event.data as Record<string, any>
        if (typeof streamEvent.content === "string") full = streamEvent.content
        if (typeof streamEvent.thinking === "string") thinking = streamEvent.thinking
        if (typeof streamEvent.delta === "string" && streamEvent.type === "text") full += streamEvent.delta
        if (typeof streamEvent.delta === "string" && streamEvent.type === "thinking") thinking += streamEvent.delta
        setConversations(previous => previous.map(conversation => conversation.id !== conversationId ? conversation : {
          ...conversation,
          messages: conversation.messages.map(message => message.id === running.assistantMessageId ? {
            ...message,
            content: full,
            thinking: thinking || undefined,
          } : message),
        }))
        if (streamEvent.type === "done" || ["completed", "failed", "cancelled"].includes(streamEvent.status)) {
          markGeneration(conversationId, {
            status: streamEvent.status === "completed" ? "completed" : streamEvent.status === "cancelled" ? "cancelled" : "error",
            generationId: running.id,
            assistantMessageId: running.assistantMessageId,
          })
          clearAbort(conversationId, controller)
          return
        }
      }
    }
    markGeneration(conversationId, {
      status: "completed",
      generationId: running.id,
      assistantMessageId: running.assistantMessageId,
    })
    clearAbort(conversationId, controller)
  } catch (error: any) {
    if (error?.name === "AbortError") return
    console.warn("resumeGenerationIfNeeded", error)
  }
}

export async function generateConversationTitle(options: {
  conversationId: string
  userText: string
  assistantText: string
  endpoint: ModelEndpointSummary | null
  setConversations: ConversationSetter
}) {
  const { conversationId, userText, assistantText, endpoint, setConversations } = options
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(endpoint ? { endpointId: endpoint.id } : { tier: "绝句" }),
        messages: [{
          role: "user",
          content: `根据下面这段对话，给出一个10字以内的标题，只输出标题本身，不要引号和标点：\n用户：${userText.slice(0, 80)}\nAI：${assistantText.slice(0, 80)}`,
        }],
      }),
    })
    if (!response.body) return

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let title = ""
    let buffer = ""
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const split = splitSseEvents(buffer + decoder.decode(value, { stream: true }))
      buffer = split.rest
      for (const eventText of split.events) {
        const event = parseSseEvent(eventText)
        if (!event || event.kind === "done") continue
        const eventData = event.data as { text?: unknown }
        if (typeof eventData.text === "string") title += eventData.text
      }
    }

    const cleanTitle = title.trim().replace(/^["'「『]|["'」』]$/g, "").slice(0, 20)
    if (cleanTitle) {
      setConversations(previous => previous.map(conversation => conversation.id === conversationId
        ? { ...conversation, title: cleanTitle }
        : conversation))
      updateConversationTitle(conversationId, cleanTitle)
    }
  } catch {}
}
