import type { EndpointAuthType } from '@/lib/model-endpoints'
import { endpointAuthHeaders, normalizeOpenAIBaseUrl } from '../openai-compatible'
import {
  MAX_JSON_BYTES,
  MediaGenerationError,
  REQUEST_TIMEOUT_MS,
  type ModelEndpointFetcher,
} from './contracts'

export function redactMediaError(value: string, apiKey: string): string {
  let safe = value
  const exactKey = apiKey.trim()
  if (exactKey) safe = safe.split(exactKey).join('***')
  return safe
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '***')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, 240)
}

export function responseErrorMessage(raw: string, apiKey: string): string {
  try {
    const payload = JSON.parse(raw)
    const message = payload?.error?.message ?? payload?.message ?? payload?.detail
      ?? payload?.error?.code ?? payload?.code
    return typeof message === 'string' ? redactMediaError(message, apiKey) : ''
  } catch {
    return redactMediaError(raw, apiKey)
  }
}

export function failForResponse(response: Response, raw: string, apiKey: string): never {
  if (response.status === 401) {
    throw new MediaGenerationError('API Key 被媒体生成接口拒绝', 'auth_failed', response.status)
  }
  const detail = responseErrorMessage(raw, apiKey)
  if (response.status === 403) {
    throw new MediaGenerationError(
      `媒体生成权限被拒绝${detail ? `：${detail}` : '，请检查当前 Key 所属分组的媒体权限'}`,
      'permission_denied',
      response.status,
    )
  }
  if (response.status === 404 || response.status === 405) {
    throw new MediaGenerationError(
      `媒体生成请求返回 ${response.status}${detail ? `：${detail}` : '；请检查 Base URL、模型 ID 与模型用途'}`,
      'media_not_found',
      response.status,
    )
  }
  throw new MediaGenerationError(
    `媒体生成失败（${response.status}）${detail ? `：${detail}` : ''}`,
    'upstream_error',
    response.status,
  )
}

export async function readLimitedBytes(
  response: Response,
  limit: number,
  label: string,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined)
    throw new MediaGenerationError(`${label}超过大小限制`, 'response_too_large')
  }
  if (!response.body) return new Uint8Array()

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) {
        await reader.cancel().catch(() => undefined)
        throw new MediaGenerationError(`${label}超过大小限制`, 'response_too_large')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

export async function readLimitedText(response: Response): Promise<string> {
  const bytes = await readLimitedBytes(response, MAX_JSON_BYTES, '模型服务响应')
  return new TextDecoder().decode(bytes)
}

export function parseMediaJson(raw: string): any {
  try {
    return JSON.parse(raw)
  } catch {
    throw new MediaGenerationError('模型服务返回了无效 JSON', 'invalid_json')
  }
}

export function parseImageSsePayloads(raw: string): any[] {
  const payloads: any[] = []
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const data = trimmed.slice(5).trim()
    if (!data || data === '[DONE]') continue
    try { payloads.push(JSON.parse(data)) } catch {}
  }
  if (!payloads.length) throw new MediaGenerationError('图片生成流没有完成事件', 'empty_response')
  return payloads
}

export function combineMediaSignal(signal?: AbortSignal, timeoutMs = REQUEST_TIMEOUT_MS): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

export async function endpointRequest(
  fetcher: ModelEndpointFetcher,
  url: string,
  init: RequestInit,
  apiKey: string,
): Promise<Response> {
  try {
    return await fetcher(url, init)
  } catch (error) {
    if (init.signal?.aborted) {
      const reason = init.signal.reason
      if (reason instanceof Error && reason.name === 'TimeoutError') {
        throw new MediaGenerationError('媒体生成请求超时', 'request_timeout', 504)
      }
      throw reason instanceof Error ? reason : new DOMException('The operation was aborted', 'AbortError')
    }
    const detail = error instanceof Error ? redactMediaError(error.message, apiKey) : '未知网络错误'
    throw new MediaGenerationError(`无法连接媒体生成接口：${detail}`, 'connect_failed')
  }
}

function mediaAuthCandidates(apiKey: string, preferred: EndpointAuthType): EndpointAuthType[] {
  if (!apiKey.trim()) return ['none']
  return [...new Set<EndpointAuthType>([preferred, 'bearer', 'x-api-key', 'api-key', 'none'])]
}

export async function mediaCreationRequest(
  fetcher: ModelEndpointFetcher,
  url: string,
  init: (authType: EndpointAuthType) => RequestInit,
  apiKey: string,
  preferredAuthType: EndpointAuthType,
): Promise<{ response: Response; raw: string; authType: EndpointAuthType }> {
  const authFailures: MediaGenerationError[] = []
  for (const authType of mediaAuthCandidates(apiKey, preferredAuthType)) {
    const response = await endpointRequest(fetcher, url, init(authType), apiKey)
    const raw = await readLimitedText(response)
    if (response.status === 401) {
      try { failForResponse(response, raw, apiKey) }
      catch (error) {
        if (!(error instanceof MediaGenerationError)) throw error
        authFailures.push(error)
      }
      continue
    }
    if (response.status === 403) failForResponse(response, raw, apiKey)
    return { response, raw, authType }
  }
  throw authFailures[0] ?? new MediaGenerationError('API Key 被媒体生成接口拒绝', 'auth_failed', 401)
}

export function mediaEndpoint(baseUrl: string, suffix: string): string {
  const normalized = normalizeOpenAIBaseUrl(baseUrl)
  return `${normalized}${new URL(normalized).pathname === '/' ? '/v1' : ''}${suffix}`
}

export async function waitForMediaPoll(intervalMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason
  if (intervalMs <= 0) return
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', abort)
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, intervalMs)
    const abort = () => {
      clearTimeout(timer)
      cleanup()
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

export { endpointAuthHeaders }
