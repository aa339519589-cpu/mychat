import { isSafeModelId, type EndpointAuthType } from '@/lib/model-endpoints'
import { customModelReasoningProfile } from '@/lib/model-reasoning'
import { isRecord } from '@/lib/unknown-value'
import { anthropicMessagesUrl } from './anthropic-messages'
import { MAX_MODEL_ID, ModelEndpointError, PROBE_TIMEOUT_MS } from './openai-compatible/contracts'
import { endpointAuthHeaders, normalizeOpenAIBaseUrl } from './openai-compatible/policy'
import { readLimitedText, upstreamMessage } from './openai-compatible/response'
import { safeModelEndpointFetch } from './openai-compatible/safe-fetch'

type ProbeOptions = {
  baseUrl: string
  apiKey?: string
  authType: EndpointAuthType
  model: string
  signal?: AbortSignal
}

function probeModel(value: string): string {
  const model = value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (!isSafeModelId(model) || model.length > MAX_MODEL_ID) {
    throw new ModelEndpointError('模型 ID 无效，不能填写 URL 或 API Key', 'chat', 'invalid_model')
  }
  return model
}

function probeSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

function probeGenerationConfig(model: string): Record<string, unknown> {
  const profile = customModelReasoningProfile(model)
  if (profile.reasoningMode === 'adaptive') {
    return {
      max_tokens: 2_048,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'low' },
    }
  }
  if (profile.reasoningMode === 'budget') {
    return {
      max_tokens: 2_048,
      thinking: { type: 'enabled', budget_tokens: 1_024, display: 'summarized' },
    }
  }
  return { max_tokens: 256 }
}

async function requestProbe(options: ProbeOptions, baseUrl: string, model: string): Promise<Response> {
  try {
    return await safeModelEndpointFetch(anthropicMessagesUrl(baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'anthropic-version': '2023-06-01',
        ...endpointAuthHeaders(options.apiKey ?? '', options.authType),
      },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [{ role: 'user', content: 'Reply with exactly OK' }],
        ...probeGenerationConfig(model),
      }),
      redirect: 'manual',
      signal: probeSignal(options.signal),
    })
  } catch (error) {
    if (options.signal?.aborted || error instanceof ModelEndpointError) throw error
    const timeout = error instanceof Error && error.name === 'TimeoutError'
    throw new ModelEndpointError(
      timeout ? 'Claude 原生接口生成测试超时' : '无法连接 Claude 原生 Messages 接口',
      'chat',
      'connect_failed',
      502,
    )
  }
}

function responseError(response: Response, raw: string, apiKey: string): ModelEndpointError | null {
  if (response.ok) return null
  if (response.status === 401 || response.status === 403) {
    return new ModelEndpointError('API Key 被 Claude Messages 接口拒绝', 'chat', 'auth_failed', response.status)
  }
  const detail = upstreamMessage(raw, [apiKey])
  if (response.status === 404 || response.status === 405) {
    return new ModelEndpointError(
      `Claude Messages 请求返回 ${response.status}${detail ? `：${detail}` : '；请检查 Base URL 和模型 ID'}`,
      'chat',
      'chat_not_found',
      response.status,
    )
  }
  return new ModelEndpointError(
    `Claude 原生生成测试失败（${response.status}）${detail ? `：${detail}` : ''}`,
    'chat',
    'upstream_error',
    response.status,
  )
}

export function parseAnthropicProbeContent(raw: string): string {
  try {
    const payload = JSON.parse(raw) as unknown
    if (!isRecord(payload) || !Array.isArray(payload.content)) return ''
    return payload.content.map(block => {
      if (!isRecord(block)) return ''
      if (block.type === 'text' && typeof block.text === 'string') return block.text
      return ''
    }).join('')
  } catch {
    return ''
  }
}

export async function probeAnthropicMessages(options: ProbeOptions): Promise<{ content: string }> {
  const baseUrl = normalizeOpenAIBaseUrl(options.baseUrl)
  const model = probeModel(options.model)
  const response = await requestProbe(options, baseUrl, model)
  const raw = await readLimitedText(response, {
    stage: 'chat',
    tooLargeMessage: 'Claude Messages 接口响应过大',
  })
  const failure = responseError(response, raw, options.apiKey ?? '')
  if (failure) throw failure
  const content = parseAnthropicProbeContent(raw).trim()
  if (!content) {
    throw new ModelEndpointError(
      'Claude Messages 接口已响应，但没有生成文本；请检查模型 ID',
      'chat',
      'empty_response',
      422,
    )
  }
  return { content: content.slice(0, 200) }
}
