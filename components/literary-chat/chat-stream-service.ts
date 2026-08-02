import type { Dispatch, SetStateAction } from 'react'
import type { Conversation, Tier } from '@/lib/chat-data'
import type { AttachedFile } from '@/lib/file-extract'
import type { Memory } from '@/lib/memory-data'
import type { ModelEndpointSummary } from '@/lib/model-endpoints'
import type { ProjectContext } from '@/lib/project-data'
import type { SearchMode } from '@/lib/search-mode'
import { errorMessage } from '@/lib/unknown-value'
import type { ClientGenerationPatch, ClientGenerationState } from '@/lib/generation-client'
import type { ChatTurnAuthority } from '@/lib/llm/chat-request'
import { takeAcknowledgedGenerationTerminal } from './generation-terminal-registry'
import { finalizeChatStream } from './chat-stream-finalizer'
import { enqueueJobUntilAccepted } from './durable-job-enqueue'
import { streamJobEvents, type AcceptedJob } from './job-stream-client'
import { removePermanentlyRejectedSubmission, removePendingChatSubmission, savePendingChatSubmission } from './pending-chat-submission'
import { processChatStreamEvent } from './chat-stream-events'
import { createChatStreamRenderer, createChatStreamState, type ChatStreamRenderer, type ChatStreamState } from './chat-stream-state'

export type HistoryMessage = { id?: string; role: string; content: string; images?: string[]; imageSummary?: string; ts?: string }

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
  modelId: string | null
  reasoningEffort: string | null
  memories: Memory[]
  memoryEnabled: boolean
  searchMode: SearchMode
  historyRetrieval: boolean
  renderEnabled: boolean
  showTokenUsage: boolean
  turn?: ChatTurnAuthority
  onAccepted?: () => void
  setConversations: Dispatch<SetStateAction<Conversation[]>>
  setMemories: Dispatch<SetStateAction<Memory[]>>
  markGeneration: (conversationId: string, patch: ClientGenerationPatch) => void
  clearAbort: (conversationId: string, controller: AbortController) => void
}

export type RunChatStreamResult = { content: string; status: ClientGenerationState['status']; accepted: boolean }

const MODEL_QUOTA_CHANGED_EVENT = 'mychat:model-quota-changed'

function latestUserMessageId(messages: HistoryMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role === 'user' && typeof message.id === 'string') return message.id
  }
  return undefined
}

function requestBody(options: RunChatStreamOptions): Record<string, unknown> {
  const userMessageId = latestUserMessageId(options.messages)
  return {
    tier: options.tier,
    ...(options.endpoint ? { endpointId: options.endpoint.id } : {}),
    ...(options.modelId ? { modelId: options.modelId } : {}),
    ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
    messages: options.messages,
    memories: options.projectContext ? undefined : (options.memoryEnabled && options.memories.length > 0 ? options.memories : undefined),
    attachments: options.attachments?.length ? options.attachments : undefined,
    searchMode: options.searchMode,
    historyRetrieval: options.historyRetrieval,
    renderEnabled: options.renderEnabled,
    project: options.projectContext,
    conversationId: options.conversationId,
    ...(userMessageId ? { userMessageId } : {}),
    generationId: options.generationId,
    assistantMessageId: options.assistantMessageId,
    generateImage: false,
    generateVideo: false,
    ...(options.turn ? { turn: options.turn } : {}),
  }
}

function notifyModelQuotaChanged(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(MODEL_QUOTA_CHANGED_EVENT))
}

async function enqueueChatStream(options: RunChatStreamOptions, state: ChatStreamState, renderer: ChatStreamRenderer): Promise<AcceptedJob> {
  const body = requestBody(options)
  const generationId = options.generationId
  if (generationId) await savePendingChatSubmission({ schemaVersion: 1, conversationId: options.conversationId, generationId, assistantMessageId: options.assistantMessageId, path: '/api/chat', serializedBody: JSON.stringify(body), createdAt: Date.now() })
  let accepted: AcceptedJob
  try {
    accepted = await enqueueJobUntilAccepted('/api/chat', body, options.controller.signal, () => renderer.flush('消息已保存；连接恢复后会自动继续，无需重新发送。'))
  } catch (error) {
    await removePermanentlyRejectedSubmission(options.conversationId, generationId ? { id: generationId } : null, error)
    throw error
  }
  if (generationId) await removePendingChatSubmission(options.conversationId, generationId)
  notifyModelQuotaChanged()
  state.acceptedByServer = true
  options.onAccepted?.()
  state.terminalProtocolExpected = true
  options.markGeneration(options.conversationId, { status: 'running', generationId: accepted.jobId, assistantMessageId: options.assistantMessageId })
  renderer.flush()
  return accepted
}

async function consumeChatStream(options: RunChatStreamOptions, state: ChatStreamState, renderer: ChatStreamRenderer, accepted: AcceptedJob): Promise<void> {
  const context = { state, renderer, conversationId: options.conversationId, assistantMessageId: options.assistantMessageId, projectContext: options.projectContext, setConversations: options.setConversations, setMemories: options.setMemories }
  for await (const event of streamJobEvents(accepted, options.controller.signal)) { if (!processChatStreamEvent(context, event)) break }
}

function captureStreamFailure(options: RunChatStreamOptions, state: ChatStreamState, error: unknown): void {
  if (options.controller.signal.aborted) { state.aborted = true; return }
  state.terminalError = errorMessage(error, '模型生成失败')
  state.terminalProtocolExpected = false
}

function mergeAcknowledgedTerminal(options: RunChatStreamOptions, state: ChatStreamState): void {
  const acknowledged = options.generationId ? takeAcknowledgedGenerationTerminal(options.generationId) : null
  if (state.authoritativeTerminal || !acknowledged) return
  state.authoritativeTerminal = acknowledged
  state.fullReply = acknowledged.content
  state.fullThinking = acknowledged.thinking
  state.fullMedia.splice(0, state.fullMedia.length, ...acknowledged.media)
}

async function finishChatStream(options: RunChatStreamOptions, state: ChatStreamState, renderer: ChatStreamRenderer): Promise<ClientGenerationState['status']> {
  mergeAcknowledgedTerminal(options, state)
  renderer.cancel()
  return finalizeChatStream({ userId: options.userId, conversationId: options.conversationId, assistantMessageId: options.assistantMessageId, controller: options.controller, generationId: options.generationId, showTokenUsage: options.showTokenUsage, fullReply: state.fullReply, fullThinking: state.fullThinking, fullMedia: state.fullMedia, terminalError: state.terminalError, authoritativeTerminal: state.authoritativeTerminal, terminalProtocolExpected: state.terminalProtocolExpected, aborted: state.aborted, setConversations: options.setConversations, markGeneration: options.markGeneration, clearAbort: options.clearAbort, flushStreamMessage: renderer.flush })
}

export async function runChatStream(options: RunChatStreamOptions): Promise<RunChatStreamResult> {
  options.markGeneration(options.conversationId, { status: 'running', generationId: options.generationId, assistantMessageId: options.assistantMessageId })
  const state = createChatStreamState()
  const renderer = createChatStreamRenderer({ state, conversationId: options.conversationId, assistantMessageId: options.assistantMessageId, generationId: options.generationId, setConversations: options.setConversations })
  try { const accepted = await enqueueChatStream(options, state, renderer); await consumeChatStream(options, state, renderer, accepted) } catch (error) { captureStreamFailure(options, state, error) }
  const status = await finishChatStream(options, state, renderer)
  return { content: status === 'completed' ? state.fullReply : '', status, accepted: state.acceptedByServer }
}
