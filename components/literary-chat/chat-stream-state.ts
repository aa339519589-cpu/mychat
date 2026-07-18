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
  state: ChatStreamState,
  assistantMessageId: string,
  generationId: string | undefined,
  outputWarning: string | undefined,
): Message {
  if (message.id !== assistantMessageId
    || (generationId && message.generation?.id === generationId)) return message
  return {
    ...message,
    content: state.fullReply,
    thinking: state.fullThinking || undefined,
    media: state.fullMedia.length ? [...state.fullMedia] : undefined,
    isError: undefined,
    outputWarning,
  }
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

  const cancel = () => {
    if (frameId !== null) cancelAnimationFrame(frameId)
    renderScheduled = false
    frameId = null
  }
  const flush = (outputWarning?: string) => {
    renderScheduled = false
    frameId = null
    options.setConversations(previous => previous.map(conversation => {
      if (conversation.id !== options.conversationId) return conversation
      const messages = conversation.messages.map(message => streamingMessage(
        message,
        options.state,
        options.assistantMessageId,
        options.generationId,
        outputWarning,
      ))
      persistSnapshot(messages, outputWarning !== undefined)
      return { ...conversation, messages }
    }))
  }
  const schedule = () => {
    if (options.state.terminalError || options.state.aborted || renderScheduled) return
    renderScheduled = true
    frameId = requestAnimationFrame(() => flush())
  }
  return { cancel, flush, schedule }
}

export type FinalChatStreamResult = {
  content: string
  status: ClientGenerationState['status']
  accepted: boolean
}
