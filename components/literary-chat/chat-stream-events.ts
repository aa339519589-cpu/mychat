import type { Dispatch, SetStateAction } from 'react'
import type { Conversation, Message } from '@/lib/chat-data'
import type { Memory } from '@/lib/memory-data'
import type { ProjectContext } from '@/lib/project-data'
import {
  isGenerationTerminalSnapshot,
  type GenerationTerminalSnapshot,
} from '@/lib/generation/types'
import {
  MAX_GENERATED_MEDIA_ITEMS,
  normalizeGeneratedMedia,
} from '@/lib/generated-media'
import { normalizeSearchNotes } from '@/lib/search-notes'
import { isRecord } from '@/lib/unknown-value'
import type { JobStreamEnvelope } from './job-stream-client'
import type { ChatStreamRenderer, ChatStreamState } from './chat-stream-state'

type MemoryMutation = {
  action: 'create' | 'update' | 'delete'
  ok: boolean
  id?: string
  content?: string
  timestamp?: string
}

export type ChatStreamEventContext = {
  state: ChatStreamState
  renderer: ChatStreamRenderer
  conversationId: string
  assistantMessageId: string
  projectContext?: ProjectContext
  setConversations: Dispatch<SetStateAction<Conversation[]>>
  setMemories: Dispatch<SetStateAction<Memory[]>>
}

function updateAssistantMessage(
  context: ChatStreamEventContext,
  update: (message: Message) => Message,
): void {
  context.setConversations(previous => previous.map(conversation => (
    conversation.id !== context.conversationId ? conversation : {
      ...conversation,
      messages: conversation.messages.map(message => (
        message.id === context.assistantMessageId ? update(message) : message
      )),
    }
  )))
}

function parseMemoryMutation(value: unknown): MemoryMutation | null {
  if (!isRecord(value)
    || (value.action !== 'create' && value.action !== 'update' && value.action !== 'delete')
    || typeof value.ok !== 'boolean') return null
  return {
    action: value.action,
    ok: value.ok,
    ...(typeof value.id === 'string' ? { id: value.id } : {}),
    ...(typeof value.content === 'string' ? { content: value.content } : {}),
    ...(typeof value.timestamp === 'string' ? { timestamp: value.timestamp } : {}),
  }
}

function memoryNote(memory: MemoryMutation): string {
  if (memory.action === 'create') {
    return memory.ok ? `记住了：${memory.content ?? ''}` : '记忆保存失败'
  }
  if (memory.action === 'update') {
    return memory.ok ? `更新了记忆：${memory.content ?? ''}` : '记忆更新失败'
  }
  return memory.ok ? '忘记了一条记忆' : '记忆删除失败'
}

function updateMemoryList(context: ChatStreamEventContext, memory: MemoryMutation): void {
  if (!memory.ok || context.projectContext || !memory.id) return
  if (memory.action === 'create') {
    context.setMemories(previous => [
      ...previous,
      { id: memory.id!, content: memory.content ?? '', timestamp: memory.timestamp },
    ])
    return
  }
  if (memory.action === 'update') {
    context.setMemories(previous => previous.map(item => item.id === memory.id
      ? {
          ...item,
          content: memory.content ?? item.content,
          timestamp: memory.timestamp ?? item.timestamp,
        }
      : item))
    return
  }
  context.setMemories(previous => previous.filter(item => item.id !== memory.id))
}

function applyMemoryEvent(context: ChatStreamEventContext, value: unknown): boolean {
  const memory = parseMemoryMutation(value)
  if (!memory) return false
  updateAssistantMessage(context, message => ({
    ...message,
    memoryNotes: [...(message.memoryNotes ?? []), memoryNote(memory)],
  }))
  updateMemoryList(context, memory)
  return true
}

function applySearchEvent(context: ChatStreamEventContext, value: unknown): boolean {
  const search = normalizeSearchNotes([value])[0]
  if (!search) return false
  updateAssistantMessage(context, message => ({
    ...message,
    searchNotes: [...(message.searchNotes ?? []), search],
  }))
  return true
}

function applyImageSummary(context: ChatStreamEventContext, value: unknown): boolean {
  if (!isRecord(value)
    || typeof value.messageId !== 'string'
    || typeof value.summary !== 'string') return false
  const summary = value.summary.slice(0, 20_000)
  context.setConversations(previous => previous.map(conversation => (
    conversation.id !== context.conversationId ? conversation : {
      ...conversation,
      messages: conversation.messages.map(message => (
        message.id === value.messageId ? { ...message, imageSummary: summary } : message
      )),
    }
  )))
  return true
}

function isRetryEvent(event: JobStreamEnvelope): boolean {
  return event.kind === 'job.retry_scheduled'
    || (event.kind === 'job.leased'
      && typeof event.payload.attempt === 'number'
      && event.payload.attempt > 1)
}

function resetForRetry(context: ChatStreamEventContext): void {
  context.state.fullReply = ''
  context.state.fullThinking = ''
  context.state.fullMedia.splice(0, context.state.fullMedia.length)
  context.renderer.cancel()
  context.renderer.flush()
}

function terminalSnapshot(
  event: JobStreamEnvelope,
  state: ChatStreamState,
): GenerationTerminalSnapshot | null {
  const result = isRecord(event.payload.result) ? event.payload.result : {}
  const terminal = {
    status: event.payload.status,
    content: typeof result.content === 'string' ? result.content : state.fullReply,
    thinking: typeof result.thinking === 'string' ? result.thinking : state.fullThinking,
    sequence: event.seq,
    error: typeof event.payload.errorCode === 'string' ? event.payload.errorCode : null,
    media: Array.isArray(result.media) ? result.media : [],
  }
  return isGenerationTerminalSnapshot(terminal) ? terminal : null
}

function applyTerminalEvent(context: ChatStreamEventContext, event: JobStreamEnvelope): boolean {
  const terminal = terminalSnapshot(event, context.state)
  if (!terminal) {
    context.state.terminalError = '生成终态响应无效，请重新载入会话'
    context.renderer.cancel()
    return false
  }
  context.state.authoritativeTerminal = terminal
  context.state.fullReply = terminal.content
  context.state.fullThinking = terminal.thinking
  context.state.fullMedia.splice(0, context.state.fullMedia.length, ...terminal.media)
  context.renderer.cancel()
  return true
}

function applyMediaEvent(context: ChatStreamEventContext, value: unknown): void {
  const media = normalizeGeneratedMedia(value)
  if (!media
    || context.state.fullMedia.length >= MAX_GENERATED_MEDIA_ITEMS
    || context.state.fullMedia.some(item => item.type === media.type && item.url === media.url)) return
  context.state.fullMedia.push(media)
  context.renderer.schedule()
}

function applyTextDeltas(context: ChatStreamEventContext, data: Record<string, unknown>): void {
  if (typeof data.text === 'string' && data.text) {
    if (typeof window !== 'undefined' && window.localStorage?.getItem('mychat_debug_md') === '1') {
      console.debug('[mychat/md] stream delta', JSON.stringify(data.text))
    }
    context.state.fullReply += data.text
    context.renderer.schedule()
  }
  if (typeof data.thinking === 'string' && data.thinking) {
    context.state.fullThinking += data.thinking
    context.renderer.schedule()
  }
}

/** Returns false only when the caller must stop consuming the current stream. */
export function processChatStreamEvent(
  context: ChatStreamEventContext,
  event: JobStreamEnvelope,
): boolean {
  const data = event.payload
  if (isRetryEvent(event)) {
    resetForRetry(context)
    return true
  }
  if (event.kind === 'job.terminal') return applyTerminalEvent(context, event)
  if (applyMemoryEvent(context, data.memory)) return true
  if (applySearchEvent(context, data.search)) return true
  if (applyImageSummary(context, data.imageSummary)) return true
  if (data.media) {
    applyMediaEvent(context, data.media)
    return true
  }
  if (data.error) {
    context.state.terminalError = typeof data.error === 'string' ? data.error : '模型生成失败'
    context.renderer.cancel()
    return false
  }
  applyTextDeltas(context, data)
  return true
}
