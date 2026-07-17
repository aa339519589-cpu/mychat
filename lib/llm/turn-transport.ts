import { createHash } from 'node:crypto'
import type { EndpointAuthType } from '@/lib/model-endpoints'
import { safeModelEndpointFetch } from './openai-compatible'
import {
  buildProviderRequest,
  type ProviderAdapterId,
  type ReasoningEffort,
} from './provider-adapters'
import type { ModelMessage, ModelToolDefinition } from './types'

export type TurnTransportOptions = {
  adapter?: ProviderAdapterId
  authType?: EndpointAuthType
  reasoningEffort?: ReasoningEffort | null
  thinking?: boolean
  signal?: AbortSignal
  timeoutMs?: number
  fetcher?: (input: string | URL, init?: RequestInit) => Promise<Response>
  logTiming?: boolean
  maxOutputTokens?: number
  idempotencyNamespace?: string
}

export type OpenTurnResponse = {
  response: Response
  generic: boolean
  signal: AbortSignal
  timingEnabled: boolean
  startedAt: number
}

type TurnTransportInput = {
  url: string
  apiKey: string
  model: string
  messages: ModelMessage[]
  tools: ModelToolDefinition[]
  options?: TurnTransportOptions
}

function requestSignal(parent: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal {
  const signals = [parent, AbortSignal.timeout(timeoutMs ?? 120_000)].filter(Boolean) as AbortSignal[]
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals)
}

function idempotencyKey(namespace: string | undefined, body: Record<string, unknown>): string | null {
  if (!namespace) return null
  return createHash('sha256')
    .update(`${namespace}\n${JSON.stringify(body)}`)
    .digest('hex')
}

function providerRequest(input: TurnTransportInput, options: TurnTransportOptions) {
  return buildProviderRequest(options.adapter ?? 'deepseek-openai', {
    model: input.model,
    messages: input.messages,
    tools: input.tools,
    thinking: options.thinking === true,
    apiKey: input.apiKey,
    authType: options.authType,
    reasoningEffort: options.reasoningEffort,
    maxOutputTokens: options.maxOutputTokens,
  })
}

function logRequestTiming(
  input: TurnTransportInput,
  options: TurnTransportOptions,
  body: Record<string, unknown>,
  startedAt: number,
): boolean {
  const enabled = options.logTiming === true || process.env.DEBUG_LLM_TIMING === '1'
  if (!enabled) return false
  console.info('[llm/timing] request started', {
    model: input.model,
    adapter: options.adapter,
    reasoningEffort: options.reasoningEffort ?? null,
    at: startedAt,
    bodyKeys: Object.keys(body),
  })
  return true
}

export async function openTurnResponse(input: TurnTransportInput): Promise<OpenTurnResponse> {
  const options = input.options ?? {}
  const generic = options.adapter === 'generic-openai'
  const request = providerRequest(input, options)
  const signal = requestSignal(options.signal, options.timeoutMs)
  const key = idempotencyKey(options.idempotencyNamespace, request.body)
  const startedAt = Date.now()
  const timingEnabled = logRequestTiming(input, options, request.body, startedAt)
  const fetcher = options.fetcher ?? (generic ? safeModelEndpointFetch : fetch)
  const response = await fetcher(input.url, {
    method: 'POST',
    headers: {
      ...request.headers,
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    body: JSON.stringify(request.body),
    redirect: generic ? 'manual' : 'follow',
    signal,
  })
  return { response, generic, signal, timingEnabled, startedAt }
}
