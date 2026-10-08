async function requestBody(request: Request | null, body: RequestInit['body'], method: string) {
  if (body !== undefined && body !== null) return body
  if (!request || ['GET', 'HEAD'].includes(method)) return undefined
  return request.text()
}

import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { safeModelEndpointFetch } from '@/lib/llm/openai-compatible/safe-fetch'
import { ConnectorOAuthError, httpsOAuthURL } from './connector-oauth-state'

async function boundedBody(response: Response): Promise<Uint8Array | null> {
  if (!response.body) return null
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []; let count = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      count += value.byteLength
      if (count > 512 * 1024) throw new ConnectorOAuthError('OAuth 响应超过大小限制', 502)
      chunks.push(value)
    }
    const result = new Uint8Array(count); let offset = 0
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength }
    return result
  } finally { await reader.cancel().catch(() => undefined) }
}

async function requestOptions(input: Parameters<FetchLike>[0], init: RequestInit = {}) {
  const request = input instanceof Request ? input : null
  const url = httpsOAuthURL(request ? request.url : String(input))
  const headers = new Headers(request?.headers)
  new Headers(init.headers).forEach((value, key) => headers.set(key, value))
  const method = init.method ?? request?.method ?? 'GET'
  const signal = init.signal ?? request?.signal ?? AbortSignal.timeout(12_000)
  const options = { ...init, method, headers,
    body: await requestBody(request, init.body, method),
    signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]) }
  return { url, options }
}

/** All discovery, registration, token and revocation URLs use the SSRF policy. */
export const connectorOAuthFetch: FetchLike = async (input, init) => {
  const { url, options } = await requestOptions(input, init)
  const response = await safeModelEndpointFetch(url, options, { publicOnly: true })
  // Never follow a metadata redirect with credentials or redeem tokens at it.
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel(); throw new ConnectorOAuthError('OAuth 服务返回了不受支持的重定向', 502)
  }
  const body = await boundedBody(response)
  return new Response(body as BodyInit | null, { status: response.status, headers: response.headers })
}
