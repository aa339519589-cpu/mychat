import { Agent as HttpAgent, request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import { Readable } from 'node:stream'
import {
  abortReason,
  classifyModelEndpointAddress,
  resolveModelEndpoint,
  sameAddress,
  type ResolvedAddress,
} from './addresses'
import { ModelEndpointError } from './contracts'

type PinnedRequestOptions = RequestOptions & { myChatPinnedAddress?: string }

// Reuse transport connections without reusing a DNS authorization decision.
// The verified address partitions the pool as well as the original hostname;
// a new DNS answer can never borrow a socket authorized for the previous one.
class PinnedHttpAgent extends HttpAgent {
  override getName(options: PinnedRequestOptions): string {
    return `${super.getName(options)}:${options.myChatPinnedAddress ?? ''}`
  }
}

class PinnedHttpsAgent extends HttpsAgent {
  override getName(options: PinnedRequestOptions): string {
    return `${super.getName(options)}:${options.myChatPinnedAddress ?? ''}`
  }
}

const POOL_OPTIONS = {
  keepAlive: true, maxSockets: 32, maxTotalSockets: 128, maxFreeSockets: 8,
  timeout: 30_000,
}
const httpAgent = new PinnedHttpAgent(POOL_OPTIONS)
const httpsAgent = new PinnedHttpsAgent(POOL_OPTIONS)

function pinnedLookup(target: ResolvedAddress): LookupFunction {
  return (_hostname, _options, callback) => callback(null, target.address, target.family)
}

function responseHeaders(message: IncomingMessage): Headers {
  const headers = new Headers()
  for (let index = 0; index < message.rawHeaders.length; index += 2) {
    headers.append(message.rawHeaders[index], message.rawHeaders[index + 1])
  }
  return headers
}

function requestBody(body: BodyInit | null | undefined): string | Uint8Array | undefined {
  if (body === undefined || body === null) return undefined
  if (typeof body === 'string') return body
  if (body instanceof Uint8Array) return body
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  if (body instanceof URLSearchParams) return body.toString()
  throw new TypeError('模型端点请求只支持字符串或字节请求体')
}

function endpointUrl(input: string | URL): URL {
  const raw = input.toString()
  if (!raw || raw.length > 2048 || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw new ModelEndpointError('服务地址为空或格式无效', 'url', 'invalid_url')
  }
  let url: URL
  try { url = new URL(raw) } catch {
    throw new ModelEndpointError('服务地址不是有效 URL', 'url', 'invalid_url')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ModelEndpointError('服务地址只支持 http:// 或 https://', 'url', 'invalid_scheme')
  }
  if (url.username || url.password) {
    throw new ModelEndpointError('服务地址不能包含用户名或密码', 'url', 'url_credentials')
  }
  if (url.hash) throw new ModelEndpointError('服务地址不能包含锚点', 'url', 'url_query')

  return url
}

/**
 * Fetch without a second DNS resolution. HTTP Host, certificate verification,
 * and HTTPS SNI retain the original hostname while lookup stays pinned to the
 * address that passed the SSRF policy.
 */
async function resolveFetchEndpoint(url: URL, signal: AbortSignal | null | undefined, policy: { publicOnly?: boolean }) {
  const target = await resolveModelEndpoint(url, signal ?? undefined)
  if (policy.publicOnly && classifyModelEndpointAddress(target.address) !== 'public') {
    throw new ModelEndpointError('MCP 仅允许访问公网地址', 'network', 'private_url', 403)
  }
  return target
}

export async function safeModelEndpointFetch(
  input: string | URL,
  init: RequestInit = {}, policy: { publicOnly?: boolean } = {},
): Promise<Response> {
  const url = endpointUrl(input)
  const target = await resolveFetchEndpoint(url, init.signal, policy)
  const headers = new Headers(init.headers)
  headers.delete('host')
  const sendsCredential = ['authorization', 'x-api-key', 'api-key']
    .some(name => Boolean(headers.get(name)?.trim()))
  if (process.env.NODE_ENV === 'production'
    && url.protocol === 'http:'
    && classifyModelEndpointAddress(target.address) === 'public'
    && sendsCredential) {
    throw new ModelEndpointError(
      '公网模型服务携带 API Key 时必须使用 HTTPS',
      'network',
      'insecure_http',
      400,
    )
  }

  const body = requestBody(init.body)
  headers.delete('content-length')
  if (body !== undefined) headers.set('content-length', String(Buffer.byteLength(body)))
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const method = init.method ?? (body === undefined ? 'GET' : 'POST')

  return new Promise<Response>((resolve, reject) => {
    const options: PinnedRequestOptions = {
      protocol: url.protocol,
      hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method,
      headers: Object.fromEntries(headers.entries()),
      lookup: pinnedLookup(target),
      family: target.family,
      agent: url.protocol === 'https:' ? httpsAgent : httpAgent,
      myChatPinnedAddress: `${target.family}:${target.address}`,
      maxHeaderSize: 64 * 1024,
      signal: init.signal ?? undefined,
      ...(url.protocol === 'https:' && !isIP(hostname) ? { servername: hostname } : {}),
    }
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(options, message => {
      const status = message.statusCode ?? 502
      if (!Number.isInteger(status) || status < 200 || status > 599) {
        message.resume()
        reject(new ModelEndpointError(
          '模型服务返回了无效 HTTP 状态码',
          'network',
          'invalid_status',
          502,
        ))
        return
      }
      const bodyAllowed = method.toUpperCase() !== 'HEAD'
        && status !== 204
        && status !== 205
        && status !== 304
      if (!bodyAllowed) message.resume()
      if (init.signal) {
        const abortResponse = () => message.destroy(abortReason(init.signal!))
        init.signal.addEventListener('abort', abortResponse, { once: true })
        message.once('close', () => init.signal?.removeEventListener('abort', abortResponse))
      }
      try {
        resolve(new Response(
          bodyAllowed ? Readable.toWeb(message) as ReadableStream<Uint8Array> : null,
          {
            status,
            statusText: message.statusMessage,
            headers: responseHeaders(message),
          },
        ))
      } catch {
        message.destroy()
        reject(new ModelEndpointError(
          '模型服务返回了无效 HTTP 响应',
          'network',
          'invalid_response',
          502,
        ))
      }
    })

    request.on('socket', socket => {
      const verifyRemote = () => {
        if (!sameAddress(target, socket.remoteAddress)) {
          request.destroy(new ModelEndpointError(
            '模型服务连接地址与已验证地址不一致',
            'network',
            'blocked_address',
            403,
          ))
        }
      }
      if (socket.connecting) socket.once('connect', verifyRemote)
      else verifyRemote()
    })
    request.on('error', error => {
      if (init.signal?.aborted) reject(abortReason(init.signal))
      else reject(error)
    })
    if (body === undefined) request.end()
    else request.end(body)
  })
}
