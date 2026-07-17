import { isSafeModelId, type EndpointAuthType } from '@/lib/model-endpoints'
import { isRecord } from '@/lib/unknown-value'
import { chatCompletionsUrl } from '../openai'
import { MAX_MODEL_ID, ModelEndpointError, PROBE_TIMEOUT_MS } from './contracts'
import { endpointAuthHeaders, normalizeOpenAIBaseUrl } from './policy'
import { readLimitedText, upstreamMessage } from './response'
import { safeModelEndpointFetch } from './safe-fetch'

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
    throw new ModelEndpointError(
      '模型 ID 无效，不能填写 URL 或 API Key',
      'chat',
      'invalid_model',
    )
  }
  return model
}

function probeSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

async function requestProbe(
  options: ProbeOptions,
  baseUrl: string,
  model: string,
): Promise<Response> {
  try {
    return await safeModelEndpointFetch(chatCompletionsUrl(baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream, application/json',
        ...endpointAuthHeaders(options.apiKey ?? '', options.authType),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with exactly OK' }],
        stream: true,
      }),
      redirect: 'manual',
      signal: probeSignal(options.signal),
    })
  } catch (error) {
    if (options.signal?.aborted || error instanceof ModelEndpointError) throw error
    const timeout = error instanceof Error && error.name === 'TimeoutError'
    throw new ModelEndpointError(
      timeout ? '模型生成测试超时' : '无法连接聊天接口',
      'chat',
      'connect_failed',
      502,
    )
  }
}

function chatResponseError(response: Response, raw: string, apiKey: string): ModelEndpointError | null {
  if (response.ok) return null
  if (response.status === 401 || response.status === 403) {
    return new ModelEndpointError(
      'API Key 被聊天接口拒绝',
      'chat',
      'auth_failed',
      response.status,
    )
  }
  const detail = upstreamMessage(raw, [apiKey])
  if (response.status === 404 || response.status === 405) {
    const suffix = detail ? `：${detail}` : '；请检查 Base URL 和模型 ID'
    return new ModelEndpointError(
      `聊天请求返回 ${response.status}${suffix}`,
      'chat',
      'chat_not_found',
      response.status,
    )
  }
  return new ModelEndpointError(
    `模型生成测试失败（${response.status}）${detail ? `：${detail}` : ''}`,
    'chat',
    'upstream_error',
    response.status,
  )
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.map(part => {
    if (typeof part === 'string') return part
    if (!isRecord(part)) return ''
    return typeof part.text === 'string' ? part.text : ''
  }).join('')
}

function payloadContent(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.choices)) return ''
  const choice = value.choices.find(isRecord)
  if (!choice) return ''
  const delta = isRecord(choice.delta) ? choice.delta : null
  const message = isRecord(choice.message) ? choice.message : null
  return contentText(delta?.content)
    || contentText(message?.content)
    || contentText(choice.text)
}

function jsonContent(raw: string): string {
  try {
    return payloadContent(JSON.parse(raw))
  } catch {
    return ''
  }
}

function sseLineContent(line: string): string {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return ''
  const data = trimmed.slice(5).trim()
  if (!data || data === '[DONE]') return ''
  return jsonContent(data)
}

export function parseChatProbeContent(raw: string, contentType: string | null): string {
  if (contentType?.toLowerCase().includes('json')) return jsonContent(raw)
  return raw.split(/\r?\n/).map(sseLineContent).join('')
}

export async function probeOpenAIChat(options: ProbeOptions): Promise<{ content: string }> {
  const baseUrl = normalizeOpenAIBaseUrl(options.baseUrl)
  const model = probeModel(options.model)
  const response = await requestProbe(options, baseUrl, model)
  const raw = await readLimitedText(response, {
    stage: 'chat',
    tooLargeMessage: '聊天接口响应过大',
  })
  const failure = chatResponseError(response, raw, options.apiKey ?? '')
  if (failure) throw failure
  const content = parseChatProbeContent(raw, response.headers.get('content-type')).trim()
  if (!content) {
    throw new ModelEndpointError(
      '聊天接口已响应，但没有生成文本；所选模型可能不是对话模型',
      'chat',
      'empty_response',
      422,
    )
  }
  return { content: content.slice(0, 200) }
}
