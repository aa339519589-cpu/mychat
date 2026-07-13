import { isSafeModelId, type EndpointAuthType } from '@/lib/model-endpoints'
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

export async function probeOpenAIChat(options: ProbeOptions): Promise<{ content: string }> {
  const baseUrl = normalizeOpenAIBaseUrl(options.baseUrl)
  const model = options.model.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (!isSafeModelId(model) || model.length > MAX_MODEL_ID) {
    throw new ModelEndpointError(
      '模型 ID 无效，不能填写 URL 或 API Key',
      'chat',
      'invalid_model',
    )
  }

  let response: Response
  try {
    const signals = [options.signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]
      .filter(Boolean) as AbortSignal[]
    response = await safeModelEndpointFetch(chatCompletionsUrl(baseUrl), {
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
      signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
    })
  } catch (error) {
    if (options.signal?.aborted) throw error
    if (error instanceof ModelEndpointError) throw error
    throw new ModelEndpointError(
      error instanceof Error && error.name === 'TimeoutError'
        ? '模型生成测试超时'
        : '无法连接聊天接口',
      'chat',
      'connect_failed',
      502,
    )
  }

  const raw = await readLimitedText(response)
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new ModelEndpointError(
        'API Key 被聊天接口拒绝',
        'chat',
        'auth_failed',
        response.status,
      )
    }
    if (response.status === 404) {
      throw new ModelEndpointError(
        '没有找到 /chat/completions 接口',
        'chat',
        'chat_not_found',
        404,
      )
    }
    const detail = upstreamMessage(raw, [options.apiKey ?? ''])
    throw new ModelEndpointError(
      `模型生成测试失败（${response.status}）${detail ? `：${detail}` : ''}`,
      'chat',
      'upstream_error',
      response.status,
    )
  }

  let content = ''
  if (response.headers.get('content-type')?.includes('application/json')) {
    try {
      content = String(JSON.parse(raw)?.choices?.[0]?.message?.content ?? '')
    } catch {}
  } else {
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:') || trimmed === 'data: [DONE]') continue
      try {
        const event = JSON.parse(trimmed.slice(5).trim())
        content += String(
          event?.choices?.[0]?.delta?.content
          ?? event?.choices?.[0]?.message?.content
          ?? '',
        )
      } catch {}
    }
  }
  if (!content.trim()) {
    throw new ModelEndpointError(
      '聊天接口已响应，但没有生成文本；所选模型可能不是对话模型',
      'chat',
      'empty_response',
      422,
    )
  }
  return { content: content.trim().slice(0, 200) }
}
