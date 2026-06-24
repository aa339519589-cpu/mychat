export type ProviderAdapterId = 'deepseek-openai' | 'mimo-openai'

type RequestOptions = {
  model: string
  messages: any[]
  tools: any[]
  thinking: boolean
  apiKey: string
}

export function buildProviderRequest(adapter: ProviderAdapterId, opts: RequestOptions) {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    stream: true,
    thinking: { type: opts.thinking ? 'enabled' : 'disabled' },
    stream_options: { include_usage: true },
  }

  if (adapter === 'mimo-openai') body.max_completion_tokens = 65_536
  else body.max_tokens = 65_536

  if (opts.tools.length) {
    body.tools = opts.tools
    body.tool_choice = 'auto'
  }

  return {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body,
  }
}
