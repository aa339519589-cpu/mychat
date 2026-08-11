import type { EndpointAuthType } from '@/lib/model-endpoints'
import {
  customModelReasoningProfile,
  reasoningBudgetTokens,
  type ReasoningEffort,
} from '@/lib/model-reasoning'
import { isRecord } from '@/lib/unknown-value'
import type { ModelMessage, ModelToolDefinition } from './types'

export type AnthropicRequestOptions = {
  model: string
  messages: ModelMessage[]
  tools: ModelToolDefinition[]
  apiKey: string
  authType?: EndpointAuthType
  reasoningEffort?: ReasoningEffort | null
  maxOutputTokens?: number
}

type AnthropicContentBlock = Record<string, unknown>
type AnthropicMessage = { role: 'user' | 'assistant'; content: AnthropicContentBlock[] }

function cleanBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}

export function anthropicMessagesUrl(baseUrl: string): string {
  const base = cleanBaseUrl(baseUrl)
  if (/\/v1\/messages$/i.test(base) || /\/messages$/i.test(base)) return base
  if (/\/v1$/i.test(base)) return `${base}/messages`
  return `${base}/v1/messages`
}

function authHeaders(apiKey: string, authType: EndpointAuthType | undefined): Record<string, string> {
  const key = apiKey.trim()
  const selected = authType ?? 'bearer'
  if (!key || selected === 'none') return {}
  if (selected === 'x-api-key') return { 'x-api-key': key }
  if (selected === 'api-key') return { 'api-key': key }
  return { Authorization: `Bearer ${key}` }
}

function stringContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.map(part => {
    if (typeof part === 'string') return part
    if (!isRecord(part)) return ''
    return typeof part.text === 'string' ? part.text : ''
  }).join('')
}

function imageBlock(url: string): AnthropicContentBlock | null {
  const data = /^data:([^;,]+);base64,(.+)$/i.exec(url)
  if (data) {
    return {
      type: 'image',
      source: { type: 'base64', media_type: data[1], data: data[2] },
    }
  }
  if (/^https?:\/\//i.test(url)) {
    return { type: 'image', source: { type: 'url', url } }
  }
  return null
}

function contentBlocks(value: unknown): AnthropicContentBlock[] {
  if (typeof value === 'string') return value ? [{ type: 'text', text: value }] : []
  if (!Array.isArray(value)) return []
  const blocks: AnthropicContentBlock[] = []
  for (const part of value) {
    if (typeof part === 'string') {
      if (part) blocks.push({ type: 'text', text: part })
      continue
    }
    if (!isRecord(part)) continue
    if (part.type === 'text' && typeof part.text === 'string' && part.text) {
      blocks.push({ type: 'text', text: part.text })
      continue
    }
    const image = isRecord(part.image_url) ? part.image_url.url : undefined
    if (typeof image === 'string') {
      const block = imageBlock(image)
      if (block) blocks.push(block)
    }
  }
  return blocks
}

function parseToolInput(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {}
  try { return JSON.parse(value || '{}') as unknown }
  catch { return { raw: value } }
}

function assistantBlocks(message: ModelMessage): AnthropicContentBlock[] {
  if (Array.isArray(message.anthropic_content)) {
    return message.anthropic_content.filter(isRecord)
  }
  const blocks = contentBlocks(message.content)
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      if (!call?.function?.name) continue
      blocks.push({
        type: 'tool_use',
        id: call.id,
        name: call.function.name,
        input: parseToolInput(call.function.arguments),
      })
    }
  }
  return blocks
}

function toolResultBlock(message: ModelMessage): AnthropicContentBlock | null {
  if (typeof message.tool_call_id !== 'string' || !message.tool_call_id) return null
  return {
    type: 'tool_result',
    tool_use_id: message.tool_call_id,
    content: stringContent(message.content),
  }
}

function appendMessage(messages: AnthropicMessage[], role: AnthropicMessage['role'], blocks: AnthropicContentBlock[]): void {
  if (!blocks.length) return
  const last = messages[messages.length - 1]
  if (last?.role === role) {
    last.content.push(...blocks)
    return
  }
  messages.push({ role, content: blocks })
}

function anthropicMessages(messages: ModelMessage[]): { system?: string; messages: AnthropicMessage[] } {
  const systemParts: string[] = []
  const converted: AnthropicMessage[] = []
  for (const message of messages) {
    if (message.role === 'system') {
      const text = stringContent(message.content).trim()
      if (text) systemParts.push(text)
      continue
    }
    if (message.role === 'tool') {
      const result = toolResultBlock(message)
      if (result) appendMessage(converted, 'user', [result])
      continue
    }
    if (message.role === 'assistant') {
      appendMessage(converted, 'assistant', assistantBlocks(message))
      continue
    }
    if (message.role === 'user') appendMessage(converted, 'user', contentBlocks(message.content))
  }
  while (converted[0]?.role === 'assistant') converted.shift()
  return {
    ...(systemParts.length ? { system: systemParts.join('\n\n') } : {}),
    messages: converted,
  }
}

function anthropicTools(tools: ModelToolDefinition[]): Record<string, unknown>[] {
  const converted: Record<string, unknown>[] = []
  for (const tool of tools) {
    if (!isRecord(tool) || !isRecord(tool.function)) continue
    const function_ = tool.function
    if (typeof function_.name !== 'string' || !function_.name) continue
    converted.push({
      name: function_.name,
      ...(typeof function_.description === 'string' ? { description: function_.description } : {}),
      input_schema: isRecord(function_.parameters)
        ? function_.parameters
        : { type: 'object', properties: {} },
    })
  }
  return converted
}

function applyReasoning(
  body: Record<string, unknown>,
  model: string,
  effort: ReasoningEffort | null | undefined,
  maxTokens: number,
): void {
  const profile = customModelReasoningProfile(model)
  if (profile.reasoningMode === 'adaptive') {
    const selected = effort ?? profile.defaultReasoningEffort
    if (selected === 'none') {
      if (!profile.reasoningMandatory) body.thinking = { type: 'disabled' }
      return
    }
    if (!selected) return
    body.thinking = { type: 'adaptive', display: 'summarized' }
    body.output_config = { effort: selected }
    return
  }
  if (profile.reasoningMode !== 'budget') return
  const selected = effort ?? profile.defaultReasoningEffort
  if (!selected || selected === 'none') return
  const budgetTokens = reasoningBudgetTokens(profile, selected, maxTokens)
  if (budgetTokens !== null) {
    body.thinking = { type: 'enabled', budget_tokens: budgetTokens, display: 'summarized' }
  }
}

export function buildAnthropicMessagesRequest(options: AnthropicRequestOptions): {
  headers: Record<string, string>
  body: Record<string, unknown>
} {
  const maxTokens = Math.max(1, Math.min(65_536, Math.floor(options.maxOutputTokens ?? 4_096)))
  const converted = anthropicMessages(options.messages)
  const tools = anthropicTools(options.tools)
  const body: Record<string, unknown> = {
    model: options.model,
    max_tokens: maxTokens,
    stream: true,
    messages: converted.messages,
    ...(converted.system ? { system: converted.system } : {}),
    ...(tools.length ? { tools, tool_choice: { type: 'auto' } } : {}),
  }
  applyReasoning(body, options.model, options.reasoningEffort, maxTokens)
  return {
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...authHeaders(options.apiKey, options.authType),
    },
    body,
  }
}
