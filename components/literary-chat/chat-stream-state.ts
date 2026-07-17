import type { Dispatch, SetStateAction } from 'react'
import type { Conversation, Message } from '@/lib/chat-data'
import type { ClientGenerationState } from '@/lib/generation-client'
import type { GenerationTerminalSnapshot } from '@/lib/generation/types'
import type { GeneratedMedia } from '@/lib/generated-media'

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

  const cancel = () => {
    if (frameId !== null) cancelAnimationFrame(frameId)
    renderScheduled = false
    frameId = null
  }
  const flush = (outputWarning?: string) => {
    renderScheduled = false
    frameId = null
    options.setConversations(previous => previous.map(conversation => (
      conversation.id !== options.conversationId ? conversation : {
        ...conversation,
        messages: conversation.messages.map(message => streamingMessage(
          message,
          options.state,
          options.assistantMessageId,
          options.generationId,
          outputWarning,
        )),
      }
    )))
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
