import type { Dispatch, SetStateAction } from "react"
import type { Conversation } from "@/lib/chat-data"
import {
  applyConversationGenerationSnapshot,
  mergeGenerationStreamText,
  normalizeConversationGenerationSnapshot,
  toClientGenerationStatus,
  toGenerationTerminalSnapshot,
  type ClientGenerationPatch,
  type ConversationGenerationSnapshot,
} from "@/lib/generation-client"
import type { ModelEndpointSummary } from "@/lib/model-endpoints"
import { cacheGenerationTerminal, updateConversationTitle } from "@/lib/data"
import { normalizeGeneratedMediaList } from "@/lib/generated-media"
import { isGenerationTerminalSnapshot, type GenerationTerminalSnapshot } from "@/lib/generation/types"
import { parseSseEvent, splitSseEvents } from "./stream-events"

type ConversationSetter = Dispatch<SetStateAction<Conversation[]>>
type MarkGeneration = (conversationId: string, patch: ClientGenerationPatch) => void

const MAX_RESUME_ATTEMPTS = 3

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function applySnapshot(
  setConversations: ConversationSetter,
  conversationId: string,
  snapshot: ConversationGenerationSnapshot,
) {
  setConversations(previous => applyConversationGenerationSnapshot(
    previous,
    conversationId,
    snapshot,
  ))
}

async function applyTerminalSnapshot(options: {
  conversationId: string
  snapshot: ConversationGenerationSnapshot
  setConversations: ConversationSetter
  markGeneration: MarkGeneration
}) {
  const { conversationId, snapshot, setConversations, markGeneration } = options
  const terminal = toGenerationTerminalSnapshot(snapshot)
  if (!terminal) return false
  applySnapshot(setConversations, conversationId, snapshot)
  await cacheGenerationTerminal(conversationId, snapshot.assistantMessageId, {
    ...terminal,
    generationId: snapshot.id,
  }).catch(() => undefined)
  markGeneration(conversationId, {
    status: toClientGenerationStatus(snapshot.status),
    generationId: snapshot.id,
    assistantMessageId: snapshot.assistantMessageId,
    authoritativeTerminal: true,
  })
  return true
}

function markCoordinationWarning(
  setConversations: ConversationSetter,
  conversationId: string,
  assistantMessageId: string,
) {
  setConversations(previous => previous.map(conversation => conversation.id !== conversationId
    ? conversation
    : {
      ...conversation,
      messages: conversation.messages.map(message => message.id !== assistantMessageId
        ? message
        : {
          ...message,
          outputWarning: "连接暂时中断，后台任务仍在继续；重新打开会话会自动恢复。",
        }),
    }))
}

function snapshotFromStreamEvent(
  active: ConversationGenerationSnapshot,
  event: Record<string, unknown>,
): ConversationGenerationSnapshot | null {
  const terminal = event.terminal
  if (terminal && typeof terminal === "object" && !Array.isArray(terminal)) {
    return normalizeConversationGenerationSnapshot({
      id: active.id,
      conversationId: active.conversationId,
      assistantMessageId: active.assistantMessageId,
      ...(terminal as Record<string, unknown>),
    })
  }
  return normalizeConversationGenerationSnapshot({
    id: event.generationId ?? active.id,
    conversationId: event.conversationId ?? active.conversationId,
    assistantMessageId: event.assistantMessageId ?? active.assistantMessageId,
    status: event.status ?? active.status,
    content: event.content ?? active.content,
    thinking: event.thinking ?? active.thinking,
    media: event.media ?? active.media,
    sequence: event.sequence ?? active.sequence,
    error: event.error ?? null,
  })
}

export async function resumeConversationGeneration(options: {
  conversationId: string
  setConversations: ConversationSetter
  markGeneration: MarkGeneration
  registerAbort: (conversationId: string, controller: AbortController) => void
  clearAbort: (conversationId: string, controller: AbortController) => void
  onReconciled?: (available: boolean) => void
}) {
  const {
    conversationId,
    setConversations,
    markGeneration,
    registerAbort,
    clearAbort,
    onReconciled,
  } = options
  let lastActive: ConversationGenerationSnapshot | null = null
  let reconciliationReported = false
  const reportReconciliation = (available: boolean) => {
    if (reconciliationReported) return
    reconciliationReported = true
    onReconciled?.(available)
  }

  for (let attempt = 0; attempt < MAX_RESUME_ATTEMPTS; attempt += 1) {
    let controller: AbortController | null = null
    try {
      const response = await fetch(`/api/generations/running?conversationId=${encodeURIComponent(conversationId)}`)
      if (!response.ok) throw new Error(`resume_snapshot_${response.status}`)
      const data = await response.json() as Record<string, unknown>
      const rawGenerations = Array.isArray(data.generations) ? data.generations : []
      const generations = rawGenerations
        .map(normalizeConversationGenerationSnapshot)
        .filter((snapshot): snapshot is ConversationGenerationSnapshot => (
          snapshot?.conversationId === conversationId
        ))
      const latest = data.latest === null || data.latest === undefined
        ? null
        : normalizeConversationGenerationSnapshot(data.latest)
      if (data.latest !== null && data.latest !== undefined && !latest) {
        throw new Error("resume_snapshot_invalid")
      }
      const matchingLatest = latest?.conversationId === conversationId ? latest : null
      const active = generations.find(snapshot => snapshot.status === "running" || snapshot.status === "queued")
        ?? (matchingLatest?.status === "running" || matchingLatest?.status === "queued" ? matchingLatest : null)

      if (!active) {
        if (matchingLatest) {
          await applyTerminalSnapshot({ conversationId, snapshot: matchingLatest, setConversations, markGeneration })
        }
        reportReconciliation(true)
        return
      }

      lastActive = active
      applySnapshot(setConversations, conversationId, active)
      markGeneration(conversationId, {
        status: "running",
        generationId: active.id,
        assistantMessageId: active.assistantMessageId,
        begin: true,
      })
      reportReconciliation(true)

      controller = new AbortController()
      registerAbort(conversationId, controller)
      console.info("[mychat/generation] task resumed", {
        conversationId,
        generationId: active.id,
        assistantMessageId: active.assistantMessageId,
        afterSequence: active.sequence,
        attempt: attempt + 1,
      })
      const streamResponse = await fetch(
        `/api/generations/${active.id}/stream?afterSequence=${active.sequence}`,
        { signal: controller.signal },
      )
      if (!streamResponse.ok || !streamResponse.body) {
        throw new Error(`resume_stream_${streamResponse.status}`)
      }

      const reader = streamResponse.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      let current = active
      let retry = true

      streamLoop: while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const split = splitSseEvents(buffer + decoder.decode(value, { stream: true }))
        buffer = split.rest
        for (const eventText of split.events) {
          const parsed = parseSseEvent(eventText)
          if (!parsed || parsed.kind === "done") continue
          const event = parsed.data as Record<string, unknown>
          if (event.heartbeat === true) continue
          const snapshot = snapshotFromStreamEvent(current, event)
          if (!snapshot || snapshot.id !== active.id || snapshot.conversationId !== conversationId) {
            break streamLoop
          }

          if (toGenerationTerminalSnapshot(snapshot)) {
            await applyTerminalSnapshot({ conversationId, snapshot, setConversations, markGeneration })
            retry = false
            break streamLoop
          }
          if (event.type === "error" || event.recoverable === true) break streamLoop

          const merged = mergeGenerationStreamText(
            { content: current.content, thinking: current.thinking },
            event,
          )
          const media = Array.isArray(event.media)
            ? normalizeGeneratedMediaList(event.media)
            : current.media
          current = {
            ...snapshot,
            status: snapshot.status === "queued" ? "queued" : "running",
            content: merged.content,
            thinking: merged.thinking,
            media,
            error: null,
          }
          lastActive = current
          applySnapshot(setConversations, conversationId, current)
        }
      }
      await reader.cancel().catch(() => undefined)
      if (!retry) return
    } catch (error: unknown) {
      if (controller?.signal.aborted || (error instanceof Error && error.name === "AbortError")) return
      console.warn("resumeGenerationIfNeeded", error instanceof Error ? error.message : "unknown")
    } finally {
      if (controller) clearAbort(conversationId, controller)
    }

    if (attempt + 1 < MAX_RESUME_ATTEMPTS) await delay(350 * (attempt + 1))
  }

  if (lastActive) {
    markGeneration(conversationId, {
      status: "running",
      generationId: lastActive.id,
      assistantMessageId: lastActive.assistantMessageId,
    })
    markCoordinationWarning(setConversations, conversationId, lastActive.assistantMessageId)
  }
  reportReconciliation(false)
}

type CancellationFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

export async function requestClientGenerationCancellation(
  generationId: string,
  options: { fetcher?: CancellationFetcher; timeoutMs?: number } = {},
): Promise<GenerationTerminalSnapshot> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000)
  try {
    const response = await (options.fetcher ?? fetch)(
      `/api/generations/${generationId}/cancel`,
      { method: "POST", signal: controller.signal },
    )
    if (!response.ok) throw new Error(`generation_cancel_${response.status}`)
    const data = await response.json() as { terminal?: unknown }
    if (!isGenerationTerminalSnapshot(data.terminal)) {
      throw new Error("generation_cancel_invalid_response")
    }
    return data.terminal
  } finally {
    clearTimeout(timeout)
  }
}

export async function applyClientGenerationTerminal(options: {
  conversationId: string
  assistantMessageId: string
  generationId: string
  terminal: GenerationTerminalSnapshot
  setConversations: ConversationSetter
  markGeneration: MarkGeneration
}) {
  const snapshot = normalizeConversationGenerationSnapshot({
    id: options.generationId,
    conversationId: options.conversationId,
    assistantMessageId: options.assistantMessageId,
    ...options.terminal,
  })
  if (!snapshot) return false
  return applyTerminalSnapshot({
    conversationId: options.conversationId,
    snapshot,
    setConversations: options.setConversations,
    markGeneration: options.markGeneration,
  })
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
    const response = await fetch("/api/chat/title", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId,
        userText: userText.slice(0, 2_000),
        assistantText: assistantText.slice(0, 2_000),
        ...(endpoint ? { endpointId: endpoint.id } : {}),
      }),
    })
    if (!response.ok) return
    const payload = await response.json() as { title?: unknown }
    const cleanTitle = typeof payload.title === "string" ? payload.title : ""
    if (cleanTitle) {
      setConversations(previous => previous.map(conversation => conversation.id === conversationId
        ? { ...conversation, title: cleanTitle }
        : conversation))
      updateConversationTitle(conversationId, cleanTitle)
    }
  } catch (error) {
    console.warn("generateConversationTitle", error instanceof Error ? error.name : "unknown")
  }
}
