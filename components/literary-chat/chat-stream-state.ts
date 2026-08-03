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
  flush: (outputWarning?: string) => void
  schedule: () => void
}

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
  assistantMessageId: string,
  generationId: string | undefined,
  content: string,
  thinking: string,
  media: GeneratedMedia[],
  outputWarning: string | undefined,
): Message {
  if (message.id !== assistantMessageId
    || (generationId && message.generation?.id === generationId)) return message
  return {
    ...message,
    content,
    thinking: thinking || undefined,
    media: media.length ? [...media] : undefined,
    isError: undefined,
    outputWarning,
  }
}

/** Adaptive step: 1 char when close, speed up when the buffer is ahead. */
function revealStep(backlog: number): number {
  if (backlog <= 0) return 0
  if (backlog > 40) return Math.ceil(backlog / 5)
  if (backlog > 12) return 2
  return 1
}

export function createChatStreamRenderer(options: {
  state: ChatStreamState
  conversationId: string
  assistantMessageId: string
  generationId?: string
  setConversations: Dispatch<SetStateAction<Conversation[]>>
}): ChatStreamRenderer {
  let displayedReply = ''
  let displayedThinking = ''
  let typewriterId: number | null = null
  let cacheTimer: ReturnType<typeof setTimeout> | null = null
  let latestMessages: Message[] | null = null

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

  const paint = (content: string, thinking: string, outputWarning?: string, immediateCache = false) => {
    options.setConversations(previous => previous.map(conversation => {
      if (conversation.id !== options.conversationId) return conversation
      const messages = conversation.messages.map(message => streamingMessage(
        message,
        options.assistantMessageId,
        options.generationId,
        content,
        thinking,
        options.state.fullMedia,
        outputWarning,
      ))
      // Cache authoritative full text so a mid-stream refresh does not lose tokens.
      const cacheMessages = conversation.messages.map(message => streamingMessage(
        message,
        options.assistantMessageId,
        options.generationId,
        options.state.fullReply,
        options.state.fullThinking,
        options.state.fullMedia,
        outputWarning,
      ))
      persistSnapshot(cacheMessages, immediateCache)
      return { ...conversation, messages }
    }))
  }

  const stopTypewriter = () => {
    if (typewriterId !== null) cancelAnimationFrame(typewriterId)
    typewriterId = null
  }

  const tick = () => {
    typewriterId = null
    if (options.state.terminalError || options.state.aborted) return

    const targetReply = options.state.fullReply
    const targetThinking = options.state.fullThinking

    // Retry / reset may shrink the buffer — clamp displayed text.
    if (displayedReply.length > targetReply.length) displayedReply = targetReply
    if (displayedThinking.length > targetThinking.length) displayedThinking = targetThinking

    let progressed = false
    if (displayedReply.length < targetReply.length) {
      displayedReply = targetReply.slice(
        0,
        displayedReply.length + revealStep(targetReply.length - displayedReply.length),
      )
      progressed = true
    }
    if (displayedThinking.length < targetThinking.length) {
      displayedThinking = targetThinking.slice(
        0,
        displayedThinking.length + revealStep(targetThinking.length - displayedThinking.length),
      )
      progressed = true
    }

    if (progressed) paint(displayedReply, displayedThinking)

    if (displayedReply.length < options.state.fullReply.length
      || displayedThinking.length < options.state.fullThinking.length) {
      typewriterId = requestAnimationFrame(tick)
    }
  }

  const cancel = () => {
    stopTypewriter()
  }

  /** Snap UI to authoritative text (terminal, error, explicit flush). */
  const flush = (outputWarning?: string) => {
    stopTypewriter()
    displayedReply = options.state.fullReply
    displayedThinking = options.state.fullThinking
    paint(displayedReply, displayedThinking, outputWarning, outputWarning !== undefined)
  }

  /** Start or continue character-level reveal toward the latest buffer. */
  const schedule = () => {
    if (options.state.terminalError || options.state.aborted) return
    if (typewriterId !== null) return
    typewriterId = requestAnimationFrame(tick)
  }

  return { cancel, flush, schedule }
}

export type FinalChatStreamResult = {
  content: string
  status: ClientGenerationState['status']
  accepted: boolean
}
