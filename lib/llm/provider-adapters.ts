import type { EndpointAuthType } from '@/lib/model-endpoints'
import type { ReasoningEffort } from '@/lib/model-reasoning'
import { buildAnthropicMessagesRequest } from './anthropic-messages'
import type { ModelMessage, ModelToolDefinition } from './types'

export type ProviderAdapterId = 'deepseek-openai' | 'mimo-openai' | 'generic-openai' | 'openrouter-openai' | 'anthropic-messages'
export type { ReasoningEffort } from '@/lib/model-reasoning'

type RequestOptions = {
  model: string
  messages: ModelMessage[]
  tools: ModelToolDefinition[]
  thinking: boolean
  apiKey: string
  authType?: EndpointAuthType
  reasoningEffort?: ReasoningEffort | null
  maxOutputTokens?: number
}

function outputTokenLimit(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Math.max(1, Math.min(65_536, Math.floor(value)))
}

function applyOpenRouterOptions(
  body: Record<string, unknown>,
  requestedOutputTokens: number | undefined,
  effort: ReasoningEffort | null | undefined,
): void {
  if (requestedOutputTokens !== undefined) body.max_completion_tokens = requestedOutputTokens
  // OpenRouter models with default_enabled=true keep reasoning ON at their
  // default effort when omitted. Explicit none is required to turn it off.
  if (effort === 'none') body.reasoning = { effort: 'none' }
  else if (effort) body.reasoning = { effort }
  body.stream_options = { include_usage: true }
}

function applyGenericOptions(
  body: Record<string, unknown>,
  requestedOutputTokens: number | undefined,
  effort: ReasoningEffort | null | undefined,
): void {
  if (requestedOutputTokens !== undefined) body.max_tokens = requestedOutputTokens
  if (effort === 'none') {
    body.reasoning = { effort: 'none' }
    return
  }
  if (!effort) return
  body.reasoning_effort = effort
  body.reasoning = { effort }
}

export function buildProviderRequest(adapter: ProviderAdapterId, opts: RequestOptions) {
  if (adapter === 'anthropic-messages') {
    return buildAnthropicMessagesRequest({
      model: opts.model,
      messages: opts.messages,
      tools: opts.tools,
      apiKey: opts.apiKey,
      authType: opts.authType,
      reasoningEffort: opts.reasoningEffort,
      maxOutputTokens: opts.maxOutputTokens,
    })
  }

  const body: Record<string, unknown> = { model: opts.model, messages: opts.messages, stream: true }
  const requestedOutputTokens = outputTokenLimit(opts.maxOutputTokens)
  if (adapter === 'openrouter-openai') {
    applyOpenRouterOptions(body, requestedOutputTokens, opts.reasoningEffort)
  } else if (adapter === 'generic-openai') {
    applyGenericOptions(body, requestedOutputTokens, opts.reasoningEffort)
  } else {
    body.thinking = { type: opts.thinking ? 'enabled' : 'disabled' }
    body.stream_options = { include_usage: true }
    if (adapter === 'mimo-openai') body.max_completion_tokens = requestedOutputTokens ?? 65_536
    else body.max_tokens = requestedOutputTokens ?? 65_536
  }
  if (opts.tools.length) { body.tools = opts.tools; body.tool_choice = 'auto' }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const apiKey = opts.apiKey.trim()
  const authType = opts.authType ?? 'bearer'
  if (apiKey && authType === 'bearer') headers.Authorization = `Bearer ${apiKey}`
  else if (apiKey && authType === 'x-api-key') headers['x-api-key'] = apiKey
  else if (apiKey && authType === 'api-key') headers['api-key'] = apiKey
  return { headers, body }
}
