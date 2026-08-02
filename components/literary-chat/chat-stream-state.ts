import type { Dispatch, SetStateAction } from 'react'
import type { Conversation, Message } from '@/lib/chat-data'
import type { ClientGenerationState } from '@/lib/generation-client'
import type { GenerationTerminalSnapshot } from '@/lib/generation/types'
import type { GeneratedMedia } from '@/lib/generated-media'
import { cacheConversationMessages } from '@/lib/data'

export type ChatStreamState = {
  fullReply: string
  fullThinking: string
  terminalError: string | null
  authoritativeTerminal: GenerationTerminalSnapshot | null
  terminalProtocolExpected: boolean
  aborted: boolean
  acceptedByServer: boolean
  fullMedia: GeneratedMedia[]
}

export type ChatStreamRenderer = {
  cancel: () => void
  reset: () => void
  finish: () => Promise<void>
  flush: (outputWarning?: string) => void
  schedule: () => void
}

const FINISH_DRAIN_TIMEOUT_MS = 400

export function createChatStreamState(): ChatStreamState {
  return {
    fullReply: '',
    fullThinking: '',
    terminalError: null,
    authoritativeTerminal: null,
    terminalProtocolExpected: false,
    aborted: false,
    acceptedByServer: false,
    fullMedia: [],
  }
}

function streamingMessage(
  message: Message,
  state: ChatStreamState,
  visibleReply: string,
  visibleThinking: string,
  assistantMessageId: string,
  generationId: string | undefined,
  outputWarning: string | undefined,
): Message {
  if (message.id !== assistantMessageId
    || (generationId && message.generation?.id === generationId)) return message
  return {
    ...message,
    content: visibleReply,
    thinking: visibleThinking || undefined,
    media: state.fullMedia.length ? [...state.fullMedia] : undefined,
    isError: undefined,
    outputWarning,
  }
}

function visibleStep(backlog: number, finishing: boolean): number {
  if (backlog <= 0) return 0
  if (finishing) {
    if (backlog > 512) return 64
    if (backlog > 128) return 32
    if (backlog > 32) return 16
    return Math.min(8, backlog)
  }
  if (backlog > 256) return 24
  if (backlog > 96) return 16
  if (backlog > 32) return 8
  if (backlog > 8) return 4
  return backlog
}

export function advanceVisibleText(
  visible: string,
  target: string,
  finishing = false,
): string {
  if (visible === target) return visible
  if (!target.startsWith(visible)) return target
  const remaining = Array.from(target.slice(visible.length))
  if (remaining.length === 0) return target
  const count = visible.length === 0 ? 1 : visibleStep(remaining.length, finishing)
  return visible + remaining.slice(0, count).join('')
}

export function createChatStreamRenderer(options: {
  state: ChatStreamState
  conversationId: string
  assistantMessageId: string
  generationId?: string
  setConversations: Dispatch<SetStateAction<Conversation[]>>
}): ChatStreamRenderer {
  let renderScheduled = false
  let frameId: number | null = null
  let cacheTimer: ReturnType<typeof setTimeout> | null = null
  let finishTimer: ReturnType<typeof setTimeout> | null = null
  let latestMessages: Message[] | null = null
  let visibleReply = ''
  let visibleThinking = ''
  let finishing = false
  let finishResolvers: Array<() => void> = []

  const persistSnapshot = (messages: Message[], immediate = false) => {
    latestMessages = messages
    if (immediate) {
      if (cacheTimer) clearTimeout(cacheTimer)
      cacheTimer = null
      const snapshot = latestMessages
      latestMessages = null
      cacheConversationMessages(options.conversationId, snapshot)
      return
    }
    if (cacheTimer) return
    cacheTimer = setTimeout(() => {
      cacheTimer = null
      const snapshot = latestMessages
      latestMessages = null
      if (snapshot) cacheConversationMessages(options.conversationId, snapshot)
    }, 300)
  }

  const caughtUp = () => visibleReply === options.state.fullReply
    && visibleThinking === options.state.fullThinking

  const resolveFinishes = () => {
    if (!caughtUp()) return
    if (finishTimer) clearTimeout(finishTimer)
    finishTimer = null
    const resolvers = finishResolvers
    finishResolvers = []
    for (const resolve of resolvers) resolve()
  }

  const flush = (outputWarning?: string) => {
    renderScheduled = false
    frameId = null
    options.setConversations(previous => previous.map(conversation => {
      if (conversation.id !== options.conversationId) return conversation
      const messages = conversation.messages.map(message => streamingMessage(
        message,
        options.state,
        visibleReply,
        visibleThinking,
        options.assistantMessageId,
        options.generationId,
        outputWarning,
      ))
      persistSnapshot(messages, outputWarning !== undefined)
      return { ...conversation, messages }
    }))
    resolveFinishes()
  }

  const cancelFrame = () => {
    if (frameId !== null) cancelAnimationFrame(frameId)
    renderScheduled = false
    frameId = null
  }

  const scheduleFrame = () => {
    if (renderScheduled || caughtUp()) return
    renderScheduled = true
    frameId = requestAnimationFrame(() => {
      visibleReply = advanceVisibleText(visibleReply, options.state.fullReply, finishing)
      visibleThinking = options.state.fullThinking
      flush()
      scheduleFrame()
    })
  }

  const schedule = () => {
    if (options.state.terminalError || options.state.aborted) return
    if (!visibleReply && options.state.fullReply) {
      visibleReply = advanceVisibleText('', options.state.fullReply, false)
      visibleThinking = options.state.fullThinking
      flush()
    }
    scheduleFrame()
  }

  const reset = () => {
    cancelFrame()
    finishing = false
    visibleReply = options.state.fullReply
    visibleThinking = options.state.fullThinking
    flush()
  }

  const cancel = () => {
    cancelFrame()
    if (finishTimer) clearTimeout(finishTimer)
    finishTimer = null
    const resolvers = finishResolvers
    finishResolvers = []
    for (const resolve of resolvers) resolve()
  }

  const finish = (): Promise<void> => {
    finishing = true
    if (caughtUp()) return Promise.resolve()
    schedule()
    return new Promise(resolve => {
      finishResolvers.push(resolve)
      if (!finishTimer) {
        finishTimer = setTimeout(() => {
          finishTimer = null
          cancelFrame()
          visibleReply = options.state.fullReply
          visibleThinking = options.state.fullThinking
          flush()
        }, FINISH_DRAIN_TIMEOUT_MS)
      }
    })
  }

  return { cancel, reset, finish, flush, schedule }
}

export type FinalChatStreamResult = {
  content: string
  status: ClientGenerationState['status']
  accepted: boolean
}
