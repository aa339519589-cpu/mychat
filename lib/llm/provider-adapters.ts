import type { EndpointAuthType } from '@/lib/model-endpoints'
import type { ModelMessage, ModelToolDefinition } from './types'

export type ProviderAdapterId = 'deepseek-openai' | 'mimo-openai' | 'generic-openai'
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

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

export function buildProviderRequest(adapter: ProviderAdapterId, opts: RequestOptions) {
  const body: Record<string, unknown> = { model: opts.model, messages: opts.messages, stream: true }
  const requestedOutputTokens = opts.maxOutputTokens === undefined ? undefined : Math.max(1, Math.min(65_536, Math.floor(opts.maxOutputTokens)))
  if (adapter !== 'generic-openai') {
    body.thinking = { type: opts.thinking ? 'enabled' : 'disabled' }
    body.stream_options = { include_usage: true }
    if (adapter === 'mimo-openai') body.max_completion_tokens = requestedOutputTokens ?? 65_536
    else body.max_tokens = requestedOutputTokens ?? 65_536
  } else {
    if (requestedOutputTokens !== undefined) body.max_tokens = requestedOutputTokens
    const effort = opts.reasoningEffort
    if (effort) {
      body.reasoning_effort = effort
      body.reasoning = effort === 'none' ? { enabled: false } : { effort }
    }
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
