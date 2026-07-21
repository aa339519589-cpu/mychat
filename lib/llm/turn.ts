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
import { openTurnResponse, type OpenTurnResponse } from './turn-transport'
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
  /** Test/embedded override; production uses the bounded defaults below. */
  retryDelaysMs?: readonly number[]
}

const TURN_TRANSPORT_RETRY_DELAYS_MS = [0, 600, 1_800] as const
const SINGLE_TURN_ATTEMPT = [0] as const

export function retryableTurnStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
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

function retryDelay(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  if (delayMs <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function discardRetryResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // The failed response is already unusable; a cancellation failure must not
    // prevent the next idempotent provider attempt.
  }
}

function retryDelays(options: RunTurnOptions | undefined): readonly number[] {
  if (options?.retryDelaysMs?.length) return options.retryDelaysMs
  // User-defined generic endpoints are opaque and may return one-shot bodies or
  // implement their own retry semantics. Keep automatic retries on platform
  // providers only; explicit callers can still opt in through retryDelaysMs.
  if (options?.adapter === 'generic-openai') return SINGLE_TURN_ATTEMPT
  return TURN_TRANSPORT_RETRY_DELAYS_MS
}

function responseEndsRetry(opened: OpenTurnResponse, finalAttempt: boolean): boolean {
  if (opened.response.ok) return true
  if (!retryableTurnStatus(opened.response.status)) return true
  return finalAttempt
}

function assertRetryCanContinue(
  error: unknown,
  signal: AbortSignal | undefined,
  finalAttempt: boolean,
): void {
  if (signal?.aborted) throw signal.reason ?? error
  if (finalAttempt) throw error
}

async function openTurnWithRetry(input: {
  url: string
  apiKey: string
  model: string
  messages: ModelMessage[]
  tools: ModelToolDefinition[]
  options?: RunTurnOptions
}): Promise<OpenTurnResponse> {
  const delays = retryDelays(input.options)
  let lastError: unknown = null
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    await retryDelay(delays[attempt] ?? 0, input.options?.signal)
    const finalAttempt = attempt === delays.length - 1
    try {
      const opened = await openTurnResponse(input)
      if (responseEndsRetry(opened, finalAttempt)) return opened
      await discardRetryResponse(opened.response)
    } catch (error) {
      lastError = error
      assertRetryCanContinue(error, input.options?.signal, finalAttempt)
    }
  }
  throw lastError ?? new Error('模型服务连接失败')
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
  const opened = await openTurnWithRetry({ url, apiKey, model, messages, tools, options })
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
