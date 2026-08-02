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

type ChatStreamRendererOptions = {
  state: ChatStreamState
  conversationId: string
  assistantMessageId: string
  generationId?: string
  setConversations: Dispatch<SetStateAction<Conversation[]>>
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

class ChatStreamRenderController implements ChatStreamRenderer {
  private renderScheduled = false
  private frameId: number | null = null
  private cacheTimer: ReturnType<typeof setTimeout> | null = null
  private finishTimer: ReturnType<typeof setTimeout> | null = null
  private latestMessages: Message[] | null = null
  private visibleReply = ''
  private visibleThinking = ''
  private finishing = false
  private finishResolvers: Array<() => void> = []

  constructor(private readonly options: ChatStreamRendererOptions) {}

  flush = (outputWarning?: string): void => {
    this.renderScheduled = false
    this.frameId = null
    this.options.setConversations(previous => previous.map(conversation => {
      if (conversation.id !== this.options.conversationId) return conversation
      const messages = conversation.messages.map(message => streamingMessage(
        message,
        this.options.state,
        this.visibleReply,
        this.visibleThinking,
        this.options.assistantMessageId,
        this.options.generationId,
        outputWarning,
      ))
      this.persistSnapshot(messages, outputWarning !== undefined)
      return { ...conversation, messages }
    }))
    this.resolveFinishes()
  }

  schedule = (): void => {
    if (this.options.state.terminalError || this.options.state.aborted) return
    if (!this.visibleReply && this.options.state.fullReply) {
      this.visibleReply = advanceVisibleText('', this.options.state.fullReply, false)
      this.visibleThinking = this.options.state.fullThinking
      this.flush()
    }
    this.scheduleFrame()
  }

  reset = (): void => {
    this.cancelFrame()
    this.finishing = false
    this.visibleReply = this.options.state.fullReply
    this.visibleThinking = this.options.state.fullThinking
    this.flush()
  }

  cancel = (): void => {
    this.cancelFrame()
    if (this.finishTimer) clearTimeout(this.finishTimer)
    this.finishTimer = null
    this.releaseFinishResolvers()
  }

  finish = (): Promise<void> => {
    this.finishing = true
    if (this.caughtUp()) return Promise.resolve()
    if (this.options.state.terminalError || this.options.state.aborted) {
      this.forceTarget()
      return Promise.resolve()
    }
    this.schedule()
    return new Promise(resolve => {
      this.finishResolvers.push(resolve)
      this.finishTimer ??= setTimeout(() => this.forceTarget(), FINISH_DRAIN_TIMEOUT_MS)
    })
  }

  private persistSnapshot(messages: Message[], immediate: boolean): void {
    this.latestMessages = messages
    if (immediate) {
      if (this.cacheTimer) clearTimeout(this.cacheTimer)
      this.cacheTimer = null
      this.persistLatest()
      return
    }
    this.cacheTimer ??= setTimeout(() => {
      this.cacheTimer = null
      this.persistLatest()
    }, 300)
  }

  private persistLatest(): void {
    const snapshot = this.latestMessages
    this.latestMessages = null
    if (snapshot) cacheConversationMessages(this.options.conversationId, snapshot)
  }

  private caughtUp(): boolean {
    return this.visibleReply === this.options.state.fullReply
      && this.visibleThinking === this.options.state.fullThinking
  }

  private resolveFinishes(): void {
    if (!this.caughtUp()) return
    if (this.finishTimer) clearTimeout(this.finishTimer)
    this.finishTimer = null
    this.releaseFinishResolvers()
  }

  private releaseFinishResolvers(): void {
    const resolvers = this.finishResolvers
    this.finishResolvers = []
    for (const resolve of resolvers) resolve()
  }

  private cancelFrame(): void {
    if (this.frameId !== null) cancelAnimationFrame(this.frameId)
    this.renderScheduled = false
    this.frameId = null
  }

  private scheduleFrame(): void {
    if (this.renderScheduled || this.caughtUp()) return
    this.renderScheduled = true
    this.frameId = requestAnimationFrame(() => {
      this.visibleReply = advanceVisibleText(
        this.visibleReply,
        this.options.state.fullReply,
        this.finishing,
      )
      this.visibleThinking = this.options.state.fullThinking
      this.flush()
      this.scheduleFrame()
    })
  }

  private forceTarget(): void {
    if (this.finishTimer) clearTimeout(this.finishTimer)
    this.finishTimer = null
    this.cancelFrame()
    this.visibleReply = this.options.state.fullReply
    this.visibleThinking = this.options.state.fullThinking
    this.flush()
  }
}

export function createChatStreamRenderer(
  options: ChatStreamRendererOptions,
): ChatStreamRenderer {
  return new ChatStreamRenderController(options)
}

export type FinalChatStreamResult = {
  content: string
  status: ClientGenerationState['status']
  accepted: boolean
}
