import dns from "node:dns/promises"
import { request as httpRequest, type IncomingMessage } from "node:http"
import { request as httpsRequest } from "node:https"
import { BlockList, isIP, type LookupFunction } from "node:net"
import { Readable } from "node:stream"
import { chatCompletionsUrl } from "./openai"
import {
  isLikelyChatModel,
  isSafeModelId,
  modelDisplayName,
  type DiscoveredModel,
  type EndpointAuthType,
} from "@/lib/model-endpoints"

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_MODELS = 500
const MAX_MODEL_ID = 512
const CONNECT_TIMEOUT_MS = 15_000
const PROBE_TIMEOUT_MS = 60_000

type ResolvedAddress = { address: string; family: 4 | 6 }

const ALWAYS_BLOCKED_ADDRESSES = new BlockList()
ALWAYS_BLOCKED_ADDRESSES.addSubnet("169.254.0.0", 16, "ipv4")
ALWAYS_BLOCKED_ADDRESSES.addSubnet("fe80::", 10, "ipv6")
// Provider-specific infrastructure addresses that are not all link-local.
ALWAYS_BLOCKED_ADDRESSES.addAddress("100.100.100.200", "ipv4")
ALWAYS_BLOCKED_ADDRESSES.addAddress("168.63.129.16", "ipv4")
ALWAYS_BLOCKED_ADDRESSES.addAddress("fd00:ec2::254", "ipv6")

const PRIVATE_ADDRESSES = new BlockList()
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) PRIVATE_ADDRESSES.addSubnet(network, prefix, "ipv4")
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001:2::", 48],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["ff00::", 8],
] as const) PRIVATE_ADDRESSES.addSubnet(network, prefix, "ipv6")

const WELL_KNOWN_NAT64 = new BlockList()
WELL_KNOWN_NAT64.addSubnet("64:ff9b::", 96, "ipv6")
const IPV4_COMPATIBLE = new BlockList()
IPV4_COMPATIBLE.addSubnet("::", 96, "ipv6")
const IPV4_TRANSLATABLE = new BlockList()
IPV4_TRANSLATABLE.addSubnet("::ffff:0:0:0", 96, "ipv6")
const SIX_TO_FOUR = new BlockList()
SIX_TO_FOUR.addSubnet("2002::", 16, "ipv6")
const FAIL_CLOSED_TRANSITION = new BlockList()
FAIL_CLOSED_TRANSITION.addSubnet("2001::", 32, "ipv6")

export type EndpointStage = "url" | "network" | "models" | "chat"

export class ModelEndpointError extends Error {
  constructor(
    message: string,
    public readonly stage: EndpointStage,
    public readonly code: string,
    public readonly status = 400,
  ) {
    super(message)
    this.name = "ModelEndpointError"
  }
}

function hasOwnField(value: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, field)
}

/** A stored endpoint reference must never be combined with caller-supplied routing fields. */
export function assertExclusiveStoredEndpointReference(body: Record<string, unknown>): void {
  if (!hasOwnField(body, "endpointId")) return
  if (Object.keys(body).some(field => field !== "endpointId")) {
    throw new ModelEndpointError(
      "使用已保存端点获取模型时不能覆盖地址、凭据或其他连接配置",
      "url",
      "stored_endpoint_override",
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
  const explicitlyProvided = hasOwnField(body, "apiKey")
  if (explicitlyProvided && typeof body.apiKey !== "string") {
    throw new ModelEndpointError("API Key 格式无效", "url", "invalid_api_key", 400)
  }
  if (currentBaseUrl !== nextBaseUrl && !explicitlyProvided) {
    throw new ModelEndpointError(
      "更换服务地址时必须重新填写 API Key；无鉴权端点请显式留空",
      "url",
      "new_api_key_required",
      400,
    )
  }
  return explicitlyProvided ? (body.apiKey as string).trim() : readCurrentApiKey()
}

function cleanPath(pathname: string): string {
  let path = pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "")
  path = path.replace(/\/(?:models|chat\/completions)$/i, "")
  return path === "/" ? "" : path
}

export function normalizeOpenAIBaseUrl(raw: string): string {
  const value = raw.trim()
  if (!value || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ModelEndpointError("服务地址为空或格式无效", "url", "invalid_url")
  }

  let url: URL
  try { url = new URL(value) } catch {
    throw new ModelEndpointError("服务地址不是有效 URL", "url", "invalid_url")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ModelEndpointError("服务地址只支持 http:// 或 https://", "url", "invalid_scheme")
  }
  if (url.username || url.password) {
    throw new ModelEndpointError("服务地址不能包含用户名或密码", "url", "url_credentials")
  }
  if (url.search || url.hash) {
    throw new ModelEndpointError("服务地址不能包含查询参数或锚点", "url", "url_query")
  }

  url.pathname = cleanPath(url.pathname)
  return url.toString().replace(/\/$/, "")
}

export function modelListUrlCandidates(baseUrl: string): string[] {
  const normalized = normalizeOpenAIBaseUrl(baseUrl)
  const url = new URL(normalized)
  const path = url.pathname.replace(/\/$/, "")
  const candidates = /\/(?:v\d+(?:beta)?|v\d+beta\/openai)$/i.test(path)
    ? [`${normalized}/models`]
    : [`${normalized}/models`, `${normalized}/v1/models`]
  return [...new Set(candidates)]
}

export function endpointAuthHeaders(apiKey: string, authType: EndpointAuthType): Record<string, string> {
  const key = apiKey.trim()
  if (!key || authType === "none") return {}
  if (authType === "x-api-key") return { "x-api-key": key }
  if (authType === "api-key") return { "api-key": key }
  return { Authorization: `Bearer ${key}` }
}

export type ModelEndpointAddressKind = "public" | "private" | "blocked"

function expandedIpv6Hextets(rawAddress: string): number[] | null {
  let address = rawAddress.toLowerCase().replace(/^\[|\]$/g, "")
  const lastColon = address.lastIndexOf(":")
  const dottedTail = lastColon >= 0 ? address.slice(lastColon + 1) : ""
  if (dottedTail.includes(".")) {
    const octets = dottedTail.split(".").map(Number)
    if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null
    const high = ((octets[0] << 8) | octets[1]).toString(16)
    const low = ((octets[2] << 8) | octets[3]).toString(16)
    address = `${address.slice(0, lastColon + 1)}${high}:${low}`
  }

  const halves = address.split("::")
  if (halves.length > 2) return null
  const parseHalf = (half: string): number[] | null => {
    if (!half) return []
    const values = half.split(":").map(part => Number.parseInt(part, 16))
    return values.some(value => !Number.isInteger(value) || value < 0 || value > 0xffff) ? null : values
  }
  const left = parseHalf(halves[0])
  const right = parseHalf(halves[1] ?? "")
  if (!left || !right) return null
  if (halves.length === 1) return left.length === 8 ? left : null
  const omitted = 8 - left.length - right.length
  if (omitted < 1) return null
  return [...left, ...new Array(omitted).fill(0), ...right]
}

function embeddedIpv4(address: string, highHextetIndex: number): string | null {
  const hextets = expandedIpv6Hextets(address)
  if (!hextets || hextets.length !== 8) return null
  const high = hextets[highHextetIndex]
  const low = hextets[highHextetIndex + 1]
  if (high === undefined || low === undefined) return null
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`
}

export function classifyModelEndpointAddress(rawAddress: string): ModelEndpointAddressKind {
  const address = rawAddress.toLowerCase().replace(/^\[|\]$/g, "")
  const version = isIP(address)
  if (!version) return "blocked"
  const family = version === 4 ? "ipv4" : "ipv6"
  if (version === 6) {
    if (FAIL_CLOSED_TRANSITION.check(address, "ipv6")) return "blocked"
    const embedded = WELL_KNOWN_NAT64.check(address, "ipv6")
      || IPV4_COMPATIBLE.check(address, "ipv6")
      || IPV4_TRANSLATABLE.check(address, "ipv6")
      ? embeddedIpv4(address, 6)
      : SIX_TO_FOUR.check(address, "ipv6")
        ? embeddedIpv4(address, 1)
        : null
    if (embedded) return classifyModelEndpointAddress(embedded)
  }
  // BlockList canonicalizes IPv6 before checking it. In particular, IPv4 rules
  // also match every textual form of an IPv4-mapped address (::ffff:0:0/96).
  if (ALWAYS_BLOCKED_ADDRESSES.check(address, family)) return "blocked"
  return PRIVATE_ADDRESSES.check(address, family) ? "private" : "public"
}

function privateEndpointAllowed(url: URL): boolean {
  if (process.env.NODE_ENV !== "production") return true
  const allowed = (process.env.MODEL_ENDPOINT_PRIVATE_ALLOWLIST ?? "")
    .split(",").map(item => item.trim().toLowerCase()).filter(Boolean)
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "")
  const hostPort = `${host}:${url.port || (url.protocol === "https:" ? "443" : "80")}`
  return allowed.includes(host) || allowed.includes(hostPort)
}

export async function validateModelEndpointNetwork(baseUrl: string): Promise<string> {
  const normalized = normalizeOpenAIBaseUrl(baseUrl)
  await resolveModelEndpoint(new URL(normalized))
  return normalized
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError")
}

async function awaitWithAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation
  if (signal.aborted) throw abortReason(signal)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal))
    signal.addEventListener("abort", onAbort, { once: true })
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort))
  })
}

async function resolveModelEndpoint(url: URL, signal?: AbortSignal): Promise<ResolvedAddress> {
  const host = url.hostname.replace(/^\[|\]$/g, "")
  const version = isIP(host)
  let addresses: ResolvedAddress[]

  if (version) {
    addresses = [{ address: host, family: version as 4 | 6 }]
  } else {
    try {
      const resolved = await awaitWithAbort(dns.lookup(host, { all: true, verbatim: true }), signal)
      addresses = resolved
        .filter((item): item is { address: string; family: 4 | 6 } => item.family === 4 || item.family === 6)
        .filter((item, index, all) => all.findIndex(candidate => candidate.address === item.address) === index)
        .sort((left, right) => left.family - right.family)
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal)
      throw new ModelEndpointError("无法解析服务地址，请检查域名", "network", "dns_failed", 502)
    }
  }

  if (!addresses.length) throw new ModelEndpointError("服务地址没有可用 IP", "network", "dns_failed", 502)
  const kinds = addresses.map(item => classifyModelEndpointAddress(item.address))
  if (kinds.includes("blocked")) {
    throw new ModelEndpointError("不允许访问链路本地或云元数据地址", "network", "blocked_address", 403)
  }
  if (!privateEndpointAllowed(url) && kinds.includes("private")) {
    throw new ModelEndpointError("该地址属于私有网络，生产环境已阻止；请在同一局域网运行 MyChat，或使用受保护的公网 HTTPS 地址", "network", "private_url", 403)
  }
  return addresses[0]
}

function sameAddress(expected: ResolvedAddress, actual: string | undefined): boolean {
  if (!actual) return false
  const actualVersion = isIP(actual)
  if (!actualVersion) return false
  const exact = new BlockList()
  exact.addAddress(expected.address, expected.family === 4 ? "ipv4" : "ipv6")
  return exact.check(actual, actualVersion === 4 ? "ipv4" : "ipv6")
}

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
  if (typeof body === "string") return body
  if (body instanceof Uint8Array) return body
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  if (body instanceof URLSearchParams) return body.toString()
  throw new TypeError("模型端点请求只支持字符串或字节请求体")
}

/**
 * Fetch an endpoint without a second DNS resolution. The original hostname is
 * retained for HTTP Host, certificate verification and HTTPS SNI, while the
 * socket lookup is pinned to the address that passed the SSRF policy.
 */
export async function safeModelEndpointFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const raw = input.toString()
  if (!raw || raw.length > 2048 || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw new ModelEndpointError("服务地址为空或格式无效", "url", "invalid_url")
  }
  let url: URL
  try { url = new URL(raw) } catch {
    throw new ModelEndpointError("服务地址不是有效 URL", "url", "invalid_url")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ModelEndpointError("服务地址只支持 http:// 或 https://", "url", "invalid_scheme")
  }
  if (url.username || url.password) {
    throw new ModelEndpointError("服务地址不能包含用户名或密码", "url", "url_credentials")
  }
  if (url.hash) throw new ModelEndpointError("服务地址不能包含锚点", "url", "url_query")

  const target = await resolveModelEndpoint(url, init.signal ?? undefined)
  const headers = new Headers(init.headers)
  headers.delete("host")
  const sendsCredential = ["authorization", "x-api-key", "api-key"]
    .some(name => !!headers.get(name)?.trim())
  if (process.env.NODE_ENV === "production"
    && url.protocol === "http:"
    && classifyModelEndpointAddress(target.address) === "public"
    && sendsCredential) {
    throw new ModelEndpointError("公网模型服务携带 API Key 时必须使用 HTTPS", "network", "insecure_http", 400)
  }
  const body = requestBody(init.body)
  headers.delete("content-length")
  if (body !== undefined) headers.set("content-length", String(Buffer.byteLength(body)))
  const hostname = url.hostname.replace(/^\[|\]$/g, "")
  const method = init.method ?? (body === undefined ? "GET" : "POST")

  return new Promise<Response>((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)({
      protocol: url.protocol,
      hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method,
      headers: Object.fromEntries(headers.entries()),
      lookup: pinnedLookup(target),
      family: target.family,
      agent: false,
      maxHeaderSize: 64 * 1024,
      signal: init.signal ?? undefined,
      ...(url.protocol === "https:" && !isIP(hostname) ? { servername: hostname } : {}),
    }, message => {
      const status = message.statusCode ?? 502
      if (!Number.isInteger(status) || status < 200 || status > 599) {
        message.resume()
        reject(new ModelEndpointError("模型服务返回了无效 HTTP 状态码", "network", "invalid_status", 502))
        return
      }
      const bodyAllowed = method.toUpperCase() !== "HEAD" && status !== 204 && status !== 205 && status !== 304
      if (!bodyAllowed) message.resume()
      if (init.signal) {
        const abortResponse = () => message.destroy(abortReason(init.signal!))
        init.signal.addEventListener("abort", abortResponse, { once: true })
        message.once("close", () => init.signal?.removeEventListener("abort", abortResponse))
      }
      try {
        resolve(new Response(bodyAllowed ? Readable.toWeb(message) as ReadableStream<Uint8Array> : null, {
          status,
          statusText: message.statusMessage,
          headers: responseHeaders(message),
        }))
      } catch {
        message.destroy()
        reject(new ModelEndpointError("模型服务返回了无效 HTTP 响应", "network", "invalid_response", 502))
      }
    })

    request.on("socket", socket => {
      const verifyRemote = () => {
        if (!sameAddress(target, socket.remoteAddress)) {
          request.destroy(new ModelEndpointError("模型服务连接地址与已验证地址不一致", "network", "blocked_address", 403))
        }
      }
      if (socket.connecting) socket.once("connect", verifyRemote)
      else verifyRemote()
    })
    request.on("error", error => {
      if (init.signal?.aborted) reject(abortReason(init.signal))
      else reject(error)
    })
    if (body === undefined) request.end()
    else request.end(body)
  })
}

async function readLimitedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    throw new ModelEndpointError("模型服务响应过大", "models", "response_too_large", 502)
  }
  if (!response.body) return ""
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new ModelEndpointError("模型服务响应过大", "models", "response_too_large", 502)
      }
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

function upstreamMessage(raw: string, secrets: string[] = []): string {
  try {
    const parsed = JSON.parse(raw)
    const message = parsed?.error?.message ?? parsed?.message
    if (typeof message !== "string") return ""
    let safe = message
    for (const secret of secrets.map(item => item.trim()).filter(Boolean)) safe = safe.split(secret).join("***")
    return safe.replace(/sk-[A-Za-z0-9_-]{8,}/g, "***").slice(0, 180)
  } catch { return "" }
}

function parseModels(raw: string, apiKey: string): DiscoveredModel[] {
  let payload: any
  try { payload = JSON.parse(raw) } catch {
    throw new ModelEndpointError("模型列表不是有效 JSON", "models", "invalid_json", 502)
  }
  const source = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : payload?.models
  if (!Array.isArray(source)) {
    throw new ModelEndpointError("模型列表格式不兼容，未找到 data[] 或 models[]", "models", "invalid_shape", 502)
  }

  const seen = new Set<string>()
  const models: DiscoveredModel[] = []
  for (const item of source) {
    const rawId = typeof item === "string" ? item : item?.id ?? item?.name
    if (typeof rawId !== "string") continue
    const id = rawId.replace(/[\u0000-\u001f\u007f]/g, "").trim()
    if (!isSafeModelId(id, apiKey) || id.length > MAX_MODEL_ID || seen.has(id)) continue
    seen.add(id)
    models.push({
      id,
      displayName: modelDisplayName(id, typeof item === "object" ? item?.display_name ?? item?.displayName : undefined, apiKey),
      ...(typeof item?.owned_by === "string" ? { ownedBy: item.owned_by.slice(0, 100) } : {}),
      chatCompatible: isLikelyChatModel(id),
    })
    if (models.length >= MAX_MODELS) break
  }
  if (!models.length) throw new ModelEndpointError("服务返回了空模型列表", "models", "empty_models", 422)
  return models
}

type DiscoverOptions = {
  baseUrl: string
  apiKey?: string
  authType?: EndpointAuthType | "auto"
  signal?: AbortSignal
}

export async function discoverOpenAIModels(options: DiscoverOptions): Promise<{
  baseUrl: string
  authType: EndpointAuthType
  models: DiscoveredModel[]
}> {
  const baseUrl = normalizeOpenAIBaseUrl(options.baseUrl)
  const apiKey = options.apiKey?.trim() ?? ""
  const authTypes: EndpointAuthType[] = options.authType && options.authType !== "auto"
    ? [options.authType]
    : apiKey ? ["bearer", "x-api-key", "api-key", "none"] : ["none"]
  let lastError: ModelEndpointError | null = null

  for (const authType of authTypes) {
    let authenticationError: ModelEndpointError | null = null
    const urls = modelListUrlCandidates(baseUrl)
    for (let urlIndex = 0; urlIndex < urls.length; urlIndex++) {
      const url = urls[urlIndex]
      let response: Response
      try {
        const signals = [options.signal, AbortSignal.timeout(CONNECT_TIMEOUT_MS)].filter(Boolean) as AbortSignal[]
        response = await safeModelEndpointFetch(url, {
          headers: { Accept: "application/json", ...endpointAuthHeaders(apiKey, authType) },
          redirect: "manual",
          signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
        })
      } catch (error) {
        if (options.signal?.aborted) throw error
        if (error instanceof ModelEndpointError) throw error
        lastError = new ModelEndpointError(error instanceof Error && error.name === "TimeoutError" ? "连接模型服务超时" : "无法连接模型服务，请检查地址和网络", "network", "connect_failed", 502)
        continue
      }
      const raw = await readLimitedText(response)
      if (response.status >= 300 && response.status < 400) {
        throw new ModelEndpointError("模型服务返回了重定向，出于凭据安全已停止", "models", "redirect_blocked", 502)
      }
      if (response.ok) {
        const discoveredBaseUrl = url === `${baseUrl}/v1/models` ? `${baseUrl}/v1` : baseUrl
        try {
          return { baseUrl: discoveredBaseUrl, authType, models: parseModels(raw, apiKey) }
        } catch (error) {
          const canTryNextUrl = error instanceof ModelEndpointError
            && ["invalid_json", "invalid_shape", "empty_models"].includes(error.code)
            && urlIndex < urls.length - 1
          if (!canTryNextUrl) throw error
          lastError = error
          continue
        }
      }
      if (response.status === 401 || response.status === 403) {
        authenticationError = new ModelEndpointError("API Key 被模型服务拒绝，请检查 Key 和权限", "models", "auth_failed", response.status)
        lastError = authenticationError
        continue
      }
      if (response.status === 404 || response.status === 405) {
        lastError = new ModelEndpointError("没有找到模型列表接口", "models", "models_not_found", response.status)
        continue
      }
      const detail = upstreamMessage(raw, [apiKey])
      throw new ModelEndpointError(`获取模型失败（${response.status}）${detail ? `：${detail}` : ""}`, "models", "upstream_error", response.status)
    }
    if (!authenticationError) throw lastError ?? new ModelEndpointError("无法获取模型列表", "models", "discovery_failed", 502)
    lastError = authenticationError
  }
  throw lastError ?? new ModelEndpointError("无法获取模型列表", "models", "discovery_failed", 502)
}

type ProbeOptions = {
  baseUrl: string
  apiKey?: string
  authType: EndpointAuthType
  model: string
  signal?: AbortSignal
}

export async function probeOpenAIChat(options: ProbeOptions): Promise<{ content: string }> {
  const baseUrl = normalizeOpenAIBaseUrl(options.baseUrl)
  const model = options.model.replace(/[\u0000-\u001f\u007f]/g, "").trim()
  if (!isSafeModelId(model) || model.length > MAX_MODEL_ID) throw new ModelEndpointError("模型 ID 无效，不能填写 URL 或 API Key", "chat", "invalid_model")

  let response: Response
  try {
    const signals = [options.signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)].filter(Boolean) as AbortSignal[]
    response = await safeModelEndpointFetch(chatCompletionsUrl(baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream, application/json",
        ...endpointAuthHeaders(options.apiKey ?? "", options.authType),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with exactly OK" }],
        stream: true,
      }),
      redirect: "manual",
      signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
    })
  } catch (error) {
    if (options.signal?.aborted) throw error
    if (error instanceof ModelEndpointError) throw error
    throw new ModelEndpointError(error instanceof Error && error.name === "TimeoutError" ? "模型生成测试超时" : "无法连接聊天接口", "chat", "connect_failed", 502)
  }

  const raw = await readLimitedText(response)
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new ModelEndpointError("API Key 被聊天接口拒绝", "chat", "auth_failed", response.status)
    if (response.status === 404) throw new ModelEndpointError("没有找到 /chat/completions 接口", "chat", "chat_not_found", 404)
    const detail = upstreamMessage(raw, [options.apiKey ?? ""])
    throw new ModelEndpointError(`模型生成测试失败（${response.status}）${detail ? `：${detail}` : ""}`, "chat", "upstream_error", response.status)
  }

  let content = ""
  if (response.headers.get("content-type")?.includes("application/json")) {
    try { content = String(JSON.parse(raw)?.choices?.[0]?.message?.content ?? "") } catch { /* handled below */ }
  } else {
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed.startsWith("data:") || trimmed === "data: [DONE]") continue
      try {
        const event = JSON.parse(trimmed.slice(5).trim())
        content += String(event?.choices?.[0]?.delta?.content ?? event?.choices?.[0]?.message?.content ?? "")
      } catch { /* ignore keepalive or malformed optional chunks */ }
    }
  }
  if (!content.trim()) throw new ModelEndpointError("聊天接口已响应，但没有生成文本；所选模型可能不是对话模型", "chat", "empty_response", 422)
  return { content: content.trim().slice(0, 200) }
}
