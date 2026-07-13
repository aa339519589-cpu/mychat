import type { EndpointAuthType } from '@/lib/model-endpoints'
import { ModelEndpointError } from './contracts'

function hasOwnField(value: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, field)
}

/** A stored endpoint reference must never be combined with caller-supplied routing fields. */
export function assertExclusiveStoredEndpointReference(body: Record<string, unknown>): void {
  if (!hasOwnField(body, 'endpointId')) return
  if (Object.keys(body).some(field => field !== 'endpointId')) {
    throw new ModelEndpointError(
      '使用已保存端点获取模型时不能覆盖地址、凭据或其他连接配置',
      'url',
      'stored_endpoint_override',
      400,
    )
  }
}

/** Resolve a PATCH credential without ever forwarding a stored key to a new base URL. */
export function resolveEndpointPatchApiKey(
  body: Record<string, unknown>,
  currentBaseUrl: string,
  nextBaseUrl: string,
  readCurrentApiKey: () => string,
): string {
  const explicitlyProvided = hasOwnField(body, 'apiKey')
  if (explicitlyProvided && typeof body.apiKey !== 'string') {
    throw new ModelEndpointError('API Key 格式无效', 'url', 'invalid_api_key', 400)
  }
  if (currentBaseUrl !== nextBaseUrl && !explicitlyProvided) {
    throw new ModelEndpointError(
      '更换服务地址时必须重新填写 API Key；无鉴权端点请显式留空',
      'url',
      'new_api_key_required',
      400,
    )
  }
  return explicitlyProvided ? (body.apiKey as string).trim() : readCurrentApiKey()
}

function cleanPath(pathname: string): string {
  let path = pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '')
  path = path.replace(/\/(?:models|chat\/completions)$/i, '')
  return path === '/' ? '' : path
}

export function normalizeOpenAIBaseUrl(raw: string): string {
  const value = raw.trim()
  if (!value || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ModelEndpointError('服务地址为空或格式无效', 'url', 'invalid_url')
  }

  let url: URL
  try { url = new URL(value) } catch {
    throw new ModelEndpointError('服务地址不是有效 URL', 'url', 'invalid_url')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ModelEndpointError('服务地址只支持 http:// 或 https://', 'url', 'invalid_scheme')
  }
  if (url.username || url.password) {
    throw new ModelEndpointError('服务地址不能包含用户名或密码', 'url', 'url_credentials')
  }
  if (url.search || url.hash) {
    throw new ModelEndpointError('服务地址不能包含查询参数或锚点', 'url', 'url_query')
  }

  url.pathname = cleanPath(url.pathname)
  return url.toString().replace(/\/$/, '')
}

export function modelListUrlCandidates(baseUrl: string): string[] {
  const normalized = normalizeOpenAIBaseUrl(baseUrl)
  const url = new URL(normalized)
  const path = url.pathname.replace(/\/$/, '')
  const candidates = /\/(?:v\d+(?:beta)?|v\d+beta\/openai)$/i.test(path)
    ? [`${normalized}/models`]
    : [`${normalized}/models`, `${normalized}/v1/models`]
  return [...new Set(candidates)]
}

export function endpointAuthHeaders(
  apiKey: string,
  authType: EndpointAuthType,
): Record<string, string> {
  const key = apiKey.trim()
  if (!key || authType === 'none') return {}
  if (authType === 'x-api-key') return { 'x-api-key': key }
  if (authType === 'api-key') return { 'api-key': key }
  return { Authorization: `Bearer ${key}` }
}
