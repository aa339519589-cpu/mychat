import type { EndpointAuthType } from '@/lib/model-endpoints'

export type ProviderAdapterId = 'deepseek-openai' | 'mimo-openai' | 'generic-openai'

type RequestOptions = {
  model: string
  messages: any[]
  tools: any[]
  thinking: boolean
  apiKey: string
  authType?: EndpointAuthType
}

export function buildProviderRequest(adapter: ProviderAdapterId, opts: RequestOptions) {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    stream: true,
  }

  if (adapter !== 'generic-openai') {
    body.thinking = { type: opts.thinking ? 'enabled' : 'disabled' }
    body.stream_options = { include_usage: true }
    if (adapter === 'mimo-openai') body.max_completion_tokens = 65_536
    else body.max_tokens = 65_536
  }

  if (opts.tools.length) {
    body.tools = opts.tools
    body.tool_choice = 'auto'
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const apiKey = opts.apiKey.trim()
  const authType = opts.authType ?? 'bearer'
  if (apiKey && authType === 'bearer') headers.Authorization = `Bearer ${apiKey}`
  else if (apiKey && authType === 'x-api-key') headers['x-api-key'] = apiKey
  else if (apiKey && authType === 'api-key') headers['api-key'] = apiKey

  return { headers, body }
}
