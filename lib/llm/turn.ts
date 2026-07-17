import type { EndpointAuthType } from '@/lib/model-endpoints'
import { upstreamError } from './stream'
import type { Emit } from './events'
import type { ProviderAdapterId, ReasoningEffort } from './provider-adapters'
import type { ModelEndpointFetcher } from './media-generation'
import { materializeOpenAICompatibleMedia } from './media-generation'
import {
  MAX_GENERIC_ERROR_RESPONSE_BYTES,
  readLimitedResponseText,
} from './turn-response'
import { consumeTurnResponse } from './turn-stream'
import { TurnAccumulator, type AccumulatedToolCall } from './turn-accumulator'
import { openTurnResponse } from './turn-transport'
import type { ModelMessage, ModelToolDefinition } from './types'

export type TurnContentPolicy = (input: {
  content: string
  hasToolCalls: boolean
}) => string

export type TurnResult = {
  assistantMessage: ModelMessage | null
  toolCalls: AccumulatedToolCall[]
  failed: boolean
  totalTokens: number
  content: string
  finishReason: string | null
  truncated: boolean
  leaked: boolean
  hasIncompleteToolCall: boolean
  reasoningContent: string
  error?: string
}

export type RunTurnOptions = {
  thinking?: boolean
  adapter?: ProviderAdapterId
  authType?: EndpointAuthType
  reasoningEffort?: ReasoningEffort | null
  deferTextUntilTurnEnd?: boolean
  contentPolicy?: TurnContentPolicy
  emitErrors?: boolean
  signal?: AbortSignal
  timeoutMs?: number
  fetcher?: (input: string | URL, init?: RequestInit) => Promise<Response>
  mediaFetcher?: ModelEndpointFetcher
  mediaBudget?: { remaining: number; seen: Set<string> }
  logTiming?: boolean
  maxOutputTokens?: number
  idempotencyNamespace?: string
}

function failedTurn(error: string): TurnResult {
  return {
    assistantMessage: null,
    toolCalls: [],
    failed: true,
    totalTokens: 0,
    content: '',
    finishReason: null,
    truncated: false,
    leaked: false,
    hasIncompleteToolCall: false,
    reasoningContent: '',
    error,
  }
}

async function responseFailure(
  response: Response,
  generic: boolean,
  apiKey: string,
  emit: Emit,
  emitErrors: boolean,
): Promise<TurnResult> {
  const rawError = generic
    ? await readLimitedResponseText(response, MAX_GENERIC_ERROR_RESPONSE_BYTES)
    : await response.text()
  const error = upstreamError(response.status, rawError, '模型服务', [apiKey])
  if (emitErrors) emit({ error })
  return failedTurn(error)
}

async function emitRemoteMedia(input: {
  accumulator: TurnAccumulator
  url: string
  apiKey: string
  options?: RunTurnOptions
  signal: AbortSignal
  emit: Emit
}): Promise<void> {
  for (const media of input.accumulator.pendingRemoteMedia) {
    const materialized = await materializeOpenAICompatibleMedia(media, {
      baseUrl: input.url,
      apiKey: input.apiKey,
      authType: input.options?.authType ?? 'bearer',
      signal: input.signal,
      fetcher: input.options?.mediaFetcher,
    })
    input.emit({ media: materialized })
  }
}

export async function runTurn(
  url: string,
  apiKey: string,
  model: string,
  messages: ModelMessage[],
  tools: ModelToolDefinition[],
  emit: Emit,
  options?: RunTurnOptions,
): Promise<TurnResult> {
  const opened = await openTurnResponse({ url, apiKey, model, messages, tools, options })
  if (!opened.response.ok || !opened.response.body) {
    return responseFailure(
      opened.response,
      opened.generic,
      apiKey,
      emit,
      options?.emitErrors !== false,
    )
  }
  const accumulator = new TurnAccumulator({
    generic: opened.generic,
    model,
    emit,
    timingEnabled: opened.timingEnabled,
    startedAt: opened.startedAt,
    deferTextUntilTurnEnd: options?.deferTextUntilTurnEnd,
    contentPolicy: options?.contentPolicy,
    maxOutputTokens: options?.maxOutputTokens,
    mediaBudget: options?.mediaBudget,
  })
  const consumed = await consumeTurnResponse(opened.response, opened.generic, accumulator.handle)
  await emitRemoteMedia({ accumulator, url, apiKey, options, signal: opened.signal, emit })
  return accumulator.finish(consumed)
}
