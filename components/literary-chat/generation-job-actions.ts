import type { Dispatch, SetStateAction } from 'react'
import type { Conversation } from '@/lib/chat-data'
import type { ModelEndpointSummary } from '@/lib/model-endpoints'
import { isGenerationTerminalSnapshot, type GenerationTerminalSnapshot } from '@/lib/generation/types'
import { enqueueJob, streamJobEvents } from './job-stream-client'

type CancellationFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

function terminalSnapshot(
  status: unknown,
  resultValue: unknown,
  sequence: unknown,
  errorCode: unknown,
): GenerationTerminalSnapshot | null {
  const result = resultValue && typeof resultValue === 'object' && !Array.isArray(resultValue)
    ? resultValue as Record<string, unknown> : {}
  const terminal = {
    status,
    content: typeof result.content === 'string' ? result.content : '',
    thinking: typeof result.thinking === 'string' ? result.thinking : '',
    sequence: Number.isSafeInteger(sequence) ? Number(sequence) : 0,
    error: typeof errorCode === 'string' ? errorCode : null,
    media: Array.isArray(result.media) ? result.media : [],
  }
  return isGenerationTerminalSnapshot(terminal) ? terminal : null
}

export async function requestClientGenerationCancellation(
  generationId: string,
  options: { fetcher?: CancellationFetcher; timeoutMs?: number } = {},
): Promise<GenerationTerminalSnapshot> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000)
  try {
    const response = await (options.fetcher ?? fetch)(`/api/v1/jobs/${generationId}/cancel`, {
      method: 'POST', signal: controller.signal,
    })
    if (!response.ok) throw new Error(`generation_cancel_${response.status}`)
    const data = await response.json() as Record<string, unknown>
    const immediate = terminalSnapshot(data.status, data.result, data.eventSeq, data.errorCode)
    if (immediate) return immediate
    for await (const event of streamJobEvents({
      jobId: generationId,
      status: typeof data.status === 'string' ? data.status : 'cancelling',
      streamUrl: `/api/v1/jobs/${generationId}/events?from_seq=0`,
    }, controller.signal)) {
      if (event.kind !== 'job.terminal') continue
      const terminal = terminalSnapshot(
        event.payload.status,
        event.payload.result,
        event.seq,
        event.payload.errorCode,
      )
      if (terminal) return terminal
    }
    throw new Error('generation_cancel_terminal_missing')
  } finally {
    clearTimeout(timeout)
  }
}

export async function generateConversationTitle(options: {
  conversationId: string
  userText: string
  assistantText: string
  endpoint: ModelEndpointSummary | null
  setConversations: Dispatch<SetStateAction<Conversation[]>>
}) {
  const { conversationId, userText, assistantText, endpoint, setConversations } = options
  const controller = new AbortController()
  try {
    const accepted = await enqueueJob('/api/chat/title', {
      conversationId,
      userText: userText.slice(0, 2_000),
      assistantText: assistantText.slice(0, 2_000),
      ...(endpoint ? { endpointId: endpoint.id } : {}),
    }, controller.signal)
    for await (const event of streamJobEvents(accepted, controller.signal)) {
      if (event.kind !== 'job.terminal' || event.payload.status !== 'completed') continue
      const result = event.payload.result && typeof event.payload.result === 'object'
        && !Array.isArray(event.payload.result)
        ? event.payload.result as Record<string, unknown> : {}
      const title = typeof result.title === 'string' ? result.title : ''
      if (title) setConversations(previous => previous.map(conversation => conversation.id === conversationId
        ? { ...conversation, title }
        : conversation))
      return
    }
  } catch (error) {
    console.warn('generateConversationTitle', error instanceof Error ? error.name : 'unknown')
  } finally {
    controller.abort()
  }
}
