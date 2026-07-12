import type { EndpointAuthType } from "@/lib/model-endpoints"
import { isSafeModelId } from "@/lib/model-endpoints"
import type { GeneratedMedia } from "@/lib/generated-media"
import {
  endpointAuthHeaders,
  normalizeOpenAIBaseUrl,
  safeModelEndpointFetch,
} from "./openai-compatible"

// Data URLs also pass through lib/generated-media.ts, whose URL cap is 16 MiB.
// Leave headroom for the MIME prefix and base64 expansion.
const MAX_JSON_BYTES = 16 * 1024 * 1024
const MAX_IMAGE_BYTES = 12 * 1024 * 1024 - 1024
const MAX_VIDEO_BYTES = 12 * 1024 * 1024 - 1024
const MAX_MEDIA_URL_LENGTH = 8 * 1024
const REQUEST_TIMEOUT_MS = 60_000
const IMAGE_GENERATION_TIMEOUT_MS = 5 * 60_000
const VIDEO_TIMEOUT_MS = 5 * 60_000
const VIDEO_POLL_INTERVAL_MS = 2_000

export type { GeneratedMedia } from "@/lib/generated-media"

export type ModelEndpointFetcher = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>

export type MediaOutputKind = "image" | "video"

export type MaterializeGeneratedMediaOptions = {
  baseUrl: string
  apiKey?: string
  authType: EndpointAuthType
  signal?: AbortSignal
  fetcher?: ModelEndpointFetcher
}

export type GenerateMediaOptions = {
  baseUrl: string
  apiKey?: string
  authType: EndpointAuthType
  model: string
  outputKind: MediaOutputKind
  prompt: string
  signal?: AbortSignal
  /** Primarily useful for deterministic tests; production uses the SSRF-safe fetcher. */
  fetcher?: ModelEndpointFetcher
  pollIntervalMs?: number
  timeoutMs?: number
  /** Skip model-id heuristics (e.g. platform Grok reverse-proxy image models). */
  forceKind?: MediaOutputKind
}

export function combineMediaGenerationSignals(
  requestSignal: AbortSignal,
  cancellationSignal: AbortSignal,
): AbortSignal {
  if (requestSignal.aborted) return requestSignal
  if (cancellationSignal.aborted) return cancellationSignal
  return AbortSignal.any([requestSignal, cancellationSignal])
}

export class MediaGenerationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status = 502,
  ) {
    super(message)
    this.name = "MediaGenerationError"
  }
}

function redact(value: string, apiKey: string): string {
  let safe = value
  const exactKey = apiKey.trim()
  if (exactKey) safe = safe.split(exactKey).join("***")
  return safe
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "***")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, 240)
}

function responseErrorMessage(raw: string, apiKey: string): string {
  try {
    const payload = JSON.parse(raw)
    const message = payload?.error?.message ?? payload?.message ?? payload?.detail
      ?? payload?.error?.code ?? payload?.code
    return typeof message === "string" ? redact(message, apiKey) : ""
  } catch {
    return redact(raw, apiKey)
  }
}

function failForResponse(response: Response, raw: string, apiKey: string): never {
  if (response.status === 401) {
    throw new MediaGenerationError("API Key 被媒体生成接口拒绝", "auth_failed", response.status)
  }
  if (response.status === 403) {
    const detail = responseErrorMessage(raw, apiKey)
    throw new MediaGenerationError(
      `媒体生成权限被拒绝${detail ? `：${detail}` : "，请检查当前 Key 所属分组的媒体权限"}`,
      "permission_denied",
      response.status,
    )
  }
  if (response.status === 404 || response.status === 405) {
    const detail = responseErrorMessage(raw, apiKey)
    throw new MediaGenerationError(
      `媒体生成请求返回 ${response.status}${detail ? `：${detail}` : "；请检查 Base URL、模型 ID 与模型用途"}`,
      "media_not_found",
      response.status,
    )
  }
  const detail = responseErrorMessage(raw, apiKey)
  throw new MediaGenerationError(
    `媒体生成失败（${response.status}）${detail ? `：${detail}` : ""}`,
    "upstream_error",
    response.status,
  )
}

async function readLimitedBytes(response: Response, limit: number, label: string): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined)
    throw new MediaGenerationError(`${label}超过大小限制`, "response_too_large")
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
        throw new MediaGenerationError(`${label}超过大小限制`, "response_too_large")
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

async function readLimitedText(response: Response): Promise<string> {
  const bytes = await readLimitedBytes(response, MAX_JSON_BYTES, "模型服务响应")
  return new TextDecoder().decode(bytes)
}

function parseJson(raw: string): any {
  try {
    return JSON.parse(raw)
  } catch {
    throw new MediaGenerationError("模型服务返回了无效 JSON", "invalid_json")
  }
}

function parseSsePayloads(raw: string): any[] {
  const payloads: any[] = []
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("data:")) continue
    const data = trimmed.slice(5).trim()
    if (!data || data === "[DONE]") continue
    try { payloads.push(JSON.parse(data)) } catch { /* Ignore optional keepalives. */ }
  }
  if (!payloads.length) throw new MediaGenerationError("图片生成流没有完成事件", "empty_response")
  return payloads
}

function estimatedBase64Bytes(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor(value.length * 3 / 4) - padding)
}

function normalizedBase64(value: string, maximumBytes: number): string {
  const compact = value.replace(/\s/g, "")
  if (!compact || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1) {
    throw new MediaGenerationError("媒体接口返回了无效 Base64 数据", "invalid_media")
  }
  if (estimatedBase64Bytes(compact) > maximumBytes) {
    throw new MediaGenerationError("生成的媒体超过大小限制", "media_too_large")
  }
  return compact
}

function dataUrlMedia(raw: string, expectedType: MediaOutputKind): GeneratedMedia | null {
  const value = raw.trim()
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new MediaGenerationError("媒体接口返回了无效 URL", "invalid_media_url")
  }
  if (!/^data:/i.test(value)) return null

  const maximum = expectedType === "image" ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES
  if (value.length > Math.ceil(maximum * 4 / 3) + 128) {
    throw new MediaGenerationError("生成的媒体超过大小限制", "media_too_large")
  }
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(value)
  const mimeType = match?.[1].toLowerCase()
  const mimeAllowed = expectedType === "image"
    ? /^image\/(?:png|jpeg|jpg|webp|gif)$/.test(mimeType ?? "")
    : /^video\/(?:mp4|webm|quicktime)$/.test(mimeType ?? "")
  if (!match || !mimeAllowed) {
    throw new MediaGenerationError("媒体接口返回了无效 Data URL", "invalid_media_url")
  }
  const base64 = normalizedBase64(match[2], maximum)
  return { type: expectedType, url: `data:${mimeType};base64,${base64}`, mimeType }
}

function remoteMediaUrl(raw: string, baseUrl: string): URL {
  const value = raw.trim()
  if (!value || value.length > MAX_MEDIA_URL_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new MediaGenerationError("媒体接口返回了无效 URL", "invalid_media_url")
  }
  let parsed: URL
  try { parsed = new URL(value, `${normalizeOpenAIBaseUrl(baseUrl)}/`) } catch {
    throw new MediaGenerationError("媒体接口返回了无效 URL", "invalid_media_url")
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password || parsed.hash) {
    throw new MediaGenerationError("媒体 URL 协议无效", "invalid_media_url")
  }
  return parsed
}

function mediaMimeType(type: MediaOutputKind, value: string | null): string | null {
  const mimeType = (value ?? "").split(";", 1)[0].trim().toLowerCase()
  if (type === "image" && /^image\/(?:png|jpeg|jpg|webp|gif)$/.test(mimeType)) return mimeType
  if (type === "video" && /^video\/(?:mp4|webm|quicktime)$/.test(mimeType)) return mimeType
  return null
}

type MaterializeContext = Pick<GenerateMediaOptions, "baseUrl" | "apiKey" | "authType" | "signal"> & {
  fetcher: ModelEndpointFetcher
}

async function materializeMediaUrl(
  raw: string,
  type: MediaOutputKind,
  prompt: string,
  context: MaterializeContext,
): Promise<GeneratedMedia> {
  const embedded = dataUrlMedia(raw, type)
  if (embedded) return { ...embedded, alt: prompt.slice(0, 300) }

  const url = remoteMediaUrl(raw, context.baseUrl)
  const baseOrigin = new URL(normalizeOpenAIBaseUrl(context.baseUrl)).origin
  const apiKey = context.apiKey?.trim() ?? ""
  const sameOrigin = url.origin === baseOrigin
  // Public CDN URLs (e.g. imgen.x.ai) are stable enough for chat history and new-tab preview.
  // Skip re-encoding to multi-MB data URLs which break open-in-new-tab and DB inserts.
  if (!sameOrigin && (url.protocol === "https:" || url.protocol === "http:")) {
    const host = url.hostname.toLowerCase()
    const publicLike = host.includes("imgen.x.ai")
      || host.includes("vidgen.x.ai")
      || host.endsWith(".x.ai")
      || host.endsWith(".supabase.co")
      || host.endsWith(".r2.dev")
      || host.endsWith(".amazonaws.com")
      || host.endsWith(".cloudfront.net")
    if (publicLike) {
      return {
        type,
        url: url.toString(),
        mimeType: type === "image" ? "image/jpeg" : "video/mp4",
        alt: prompt.slice(0, 300),
      }
    }
  }
  const response = await endpointRequest(context.fetcher, url.toString(), {
    headers: {
      Accept: type === "image" ? "image/*" : "video/*",
      ...(sameOrigin ? endpointAuthHeaders(apiKey, context.authType) : {}),
    },
    redirect: "manual",
    signal: combineSignal(context.signal),
  }, apiKey)
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined)
    throw new MediaGenerationError("媒体下载返回重定向，出于凭据和网络安全已停止", "redirect_blocked", 502)
  }
  if (!response.ok) {
    const rawError = await readLimitedText(response)
    const detail = responseErrorMessage(rawError, apiKey)
    throw new MediaGenerationError(
      `媒体下载失败（${response.status}）${detail ? `：${detail}` : ""}`,
      "media_download_failed",
      response.status,
    )
  }
  const mimeType = mediaMimeType(type, response.headers.get("content-type"))
  if (!mimeType) {
    await response.body?.cancel().catch(() => undefined)
    throw new MediaGenerationError("媒体下载响应的 Content-Type 不受支持", "invalid_media")
  }
  const limit = type === "image" ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES
  const bytes = await readLimitedBytes(response, limit, type === "image" ? "生成的图片" : "生成的视频")
  if (!bytes.byteLength) throw new MediaGenerationError("媒体内容为空", "empty_response")
  return {
    type,
    url: `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
    mimeType,
    alt: prompt.slice(0, 300),
  }
}

export async function materializeOpenAICompatibleMedia(
  media: GeneratedMedia,
  options: MaterializeGeneratedMediaOptions,
): Promise<GeneratedMedia> {
  const fetcher = options.fetcher ?? safeModelEndpointFetch
  return materializeMediaUrl(media.url, media.type, media.alt?.trim() ?? "", {
    ...options,
    fetcher,
  })
}

async function imageFromPayload(
  payload: any,
  prompt: string,
  context: MaterializeContext,
): Promise<GeneratedMedia | null> {
  const candidates = [
    ...(Array.isArray(payload?.data) ? payload.data : []),
    payload,
    ...(Array.isArray(payload?.output) ? payload.output : []),
    payload?.response,
    ...(Array.isArray(payload?.response?.data) ? payload.response.data : []),
    ...(Array.isArray(payload?.response?.output) ? payload.response.output : []),
  ]
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue
    const b64 = candidate.b64_json ?? candidate.base64 ?? candidate.result
    if (typeof b64 === "string" && b64.trim()) {
      const mimeType = typeof candidate.mime_type === "string"
        && /^image\/(?:png|jpeg|jpg|webp|gif)$/i.test(candidate.mime_type)
        ? candidate.mime_type.toLowerCase()
        : "image/png"
      const encoded = normalizedBase64(b64, MAX_IMAGE_BYTES)
      return { type: "image", url: `data:${mimeType};base64,${encoded}`, mimeType, alt: prompt.slice(0, 300) }
    }
    if (typeof candidate.url === "string") {
      return materializeMediaUrl(candidate.url, "image", prompt, context)
    }
  }
  return null
}

async function videoUrlFromPayload(
  payload: any,
  prompt: string,
  context: MaterializeContext,
): Promise<GeneratedMedia | null> {
  const candidates = [payload, payload?.data, payload?.output, payload?.result]
    .flatMap(candidate => Array.isArray(candidate) ? candidate : [candidate])
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue
    const rawUrl = candidate.url ?? candidate.video_url ?? candidate.download_url
    if (typeof rawUrl === "string") {
      return materializeMediaUrl(rawUrl, "video", prompt, context)
    }
  }
  return null
}

function combineSignal(signal: AbortSignal | undefined, timeoutMs = REQUEST_TIMEOUT_MS): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

async function endpointRequest(
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
      if (reason instanceof Error && reason.name === "TimeoutError") {
        throw new MediaGenerationError("媒体生成请求超时", "request_timeout", 504)
      }
      throw reason instanceof Error ? reason : new DOMException("The operation was aborted", "AbortError")
    }
    const detail = error instanceof Error ? redact(error.message, apiKey) : "未知网络错误"
    throw new MediaGenerationError(`无法连接媒体生成接口：${detail}`, "connect_failed")
  }
}

function mediaAuthCandidates(apiKey: string, preferred: EndpointAuthType): EndpointAuthType[] {
  if (!apiKey.trim()) return ["none"]
  return [...new Set<EndpointAuthType>([preferred, "bearer", "x-api-key", "api-key", "none"])]
}

async function mediaCreationRequest(
  fetcher: ModelEndpointFetcher,
  url: string,
  init: (authType: EndpointAuthType) => RequestInit,
  apiKey: string,
  preferredAuthType: EndpointAuthType,
): Promise<{ response: Response; raw: string; authType: EndpointAuthType }> {
  const candidates = mediaAuthCandidates(apiKey, preferredAuthType)
  const authFailures: MediaGenerationError[] = []
  for (const authType of candidates) {
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
  throw authFailures[0]
    ?? new MediaGenerationError("API Key 被媒体生成接口拒绝", "auth_failed", 401)
}

function mediaEndpoint(baseUrl: string, suffix: string): string {
  const normalized = normalizeOpenAIBaseUrl(baseUrl)
  return `${normalized}${new URL(normalized).pathname === "/" ? "/v1" : ""}${suffix}`
}

export async function generateOpenAICompatibleImage(options: GenerateMediaOptions): Promise<GeneratedMedia> {
  // Always allow when caller forces image (platform reverse-proxy model ids may not look like "flux").
  if (options.forceKind !== "image" && options.outputKind !== "image") {
    throw new MediaGenerationError("所选模型不是可识别的图片模型", "unsupported_model", 422)
  }
  const model = options.model.trim()
  if (!isSafeModelId(model)) throw new MediaGenerationError("模型 ID 无效", "invalid_model", 400)
  if (!options.prompt.trim() || options.prompt.length > 32_000) {
    throw new MediaGenerationError("媒体生成提示词为空或过长", "invalid_prompt", 400)
  }
  const fetcher = options.fetcher ?? safeModelEndpointFetch
  const apiKey = options.apiKey?.trim() ?? ""
  const creation = await mediaCreationRequest(
    fetcher,
    mediaEndpoint(options.baseUrl, "/images/generations"),
    authType => ({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...endpointAuthHeaders(apiKey, authType),
      },
      body: JSON.stringify({ model: options.model.trim(), prompt: options.prompt.trim(), n: 1, size: "1024x1024" }),
      redirect: "manual",
      signal: combineSignal(options.signal, IMAGE_GENERATION_TIMEOUT_MS),
    }),
    apiKey,
    options.authType,
  )
  const { response, raw } = creation
  if (!response.ok) failForResponse(response, raw, apiKey)
  const materializeContext: MaterializeContext = { ...options, authType: creation.authType, fetcher }

  const payloads = response.headers.get("content-type")?.includes("text/event-stream")
    || /^\s*(?:event|data):/m.test(raw)
    ? parseSsePayloads(raw)
    : [parseJson(raw)]
  for (let index = payloads.length - 1; index >= 0; index--) {
    const media = await imageFromPayload(payloads[index], options.prompt, materializeContext)
    if (media) return media
  }
  throw new MediaGenerationError("图片接口已响应，但没有返回图片", "empty_response")
}

async function waitForPoll(intervalMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason
  if (intervalMs <= 0) return
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", abort)
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, intervalMs)
    const abort = () => {
      clearTimeout(timer)
      cleanup()
      reject(signal?.reason)
    }
    signal?.addEventListener("abort", abort, { once: true })
  })
}

async function readVideoContent(response: Response, prompt: string, apiKey: string): Promise<GeneratedMedia> {
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined)
    throw new MediaGenerationError("视频下载返回重定向，出于凭据和网络安全已停止", "redirect_blocked", 502)
  }
  if (!response.ok) {
    const raw = await readLimitedText(response)
    failForResponse(response, raw, apiKey)
  }
  const responseType = (response.headers.get("content-type") ?? "video/mp4").split(";", 1)[0].trim().toLowerCase()
  const mimeType = responseType === "application/octet-stream" ? "video/mp4" : responseType
  if (!/^video\/(?:mp4|webm|quicktime)$/.test(mimeType)) {
    throw new MediaGenerationError("视频内容接口没有返回视频", "invalid_media")
  }
  const bytes = await readLimitedBytes(response, MAX_VIDEO_BYTES, "生成的视频")
  if (!bytes.byteLength) throw new MediaGenerationError("视频内容为空", "empty_response")
  return {
    type: "video",
    url: `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
    mimeType,
    alt: prompt.slice(0, 300),
  }
}

export async function generateOpenAICompatibleVideo(options: GenerateMediaOptions): Promise<GeneratedMedia> {
  const kind = validateOptions(options)
  if (kind !== "video") throw new MediaGenerationError("所选模型不是可识别的视频模型", "unsupported_model", 422)
  const fetcher = options.fetcher ?? safeModelEndpointFetch
  const apiKey = options.apiKey?.trim() ?? ""
  const normalizedBaseUrl = normalizeOpenAIBaseUrl(options.baseUrl)
  const baseUrl = new URL(normalizedBaseUrl).pathname === "/" ? `${normalizedBaseUrl}/v1` : normalizedBaseUrl
  const creation = await mediaCreationRequest(
    fetcher,
    `${baseUrl}/videos`,
    authType => ({
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...endpointAuthHeaders(apiKey, authType) },
      body: JSON.stringify({ model: options.model.trim(), prompt: options.prompt.trim(), size: "1280x720", seconds: "4" }),
      redirect: "manual",
      signal: combineSignal(options.signal),
    }),
    apiKey,
    options.authType,
  )
  const { response: create, raw: createRaw } = creation
  if (!create.ok) failForResponse(create, createRaw, apiKey)
  const commonHeaders = endpointAuthHeaders(apiKey, creation.authType)
  const materializeContext: MaterializeContext = { ...options, authType: creation.authType, fetcher }
  let job = parseJson(createRaw)
  const immediate = await videoUrlFromPayload(job, options.prompt, materializeContext)
  if (immediate) return immediate

  const id = typeof job?.id === "string" ? job.id.trim() : ""
  if (!id || id.length > 512 || /[^A-Za-z0-9_.:-]/.test(id)) {
    throw new MediaGenerationError("视频接口没有返回有效任务 ID", "invalid_job")
  }
  const startedAt = Date.now()
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.min(15 * 60_000, Math.max(1, options.timeoutMs!))
    : VIDEO_TIMEOUT_MS
  const pollIntervalMs = Number.isFinite(options.pollIntervalMs)
    ? Math.min(30_000, Math.max(0, options.pollIntervalMs!))
    : VIDEO_POLL_INTERVAL_MS

  while (true) {
    const status = String(job?.status ?? "").toLowerCase()
    if (["failed", "cancelled", "canceled", "error"].includes(status)) {
      const detail = responseErrorMessage(JSON.stringify(job), apiKey)
        || (typeof job?.error === "string" ? redact(job.error, apiKey) : "")
      throw new MediaGenerationError(`视频生成失败${detail ? `：${detail}` : ""}`, "generation_failed", 422)
    }
    if (["completed", "succeeded", "success", "done"].includes(status)) break
    if (Date.now() - startedAt >= timeoutMs) {
      throw new MediaGenerationError("视频生成等待超时", "generation_timeout", 504)
    }
    await waitForPoll(Math.min(pollIntervalMs, Math.max(0, timeoutMs - (Date.now() - startedAt))), options.signal)
    const poll = await endpointRequest(fetcher, `${baseUrl}/videos/${encodeURIComponent(id)}`, {
      headers: { Accept: "application/json", ...commonHeaders },
      redirect: "manual",
      signal: combineSignal(options.signal),
    }, apiKey)
    const pollRaw = await readLimitedText(poll)
    if (!poll.ok) failForResponse(poll, pollRaw, apiKey)
    job = parseJson(pollRaw)
    const direct = await videoUrlFromPayload(job, options.prompt, materializeContext)
    if (direct) return direct
  }

  const direct = await videoUrlFromPayload(job, options.prompt, materializeContext)
  if (direct) return direct
  const content = await endpointRequest(fetcher, `${baseUrl}/videos/${encodeURIComponent(id)}/content`, {
    headers: { Accept: "video/*, application/octet-stream", ...commonHeaders },
    redirect: "manual",
    signal: combineSignal(options.signal),
  }, apiKey)
  return readVideoContent(content, options.prompt, apiKey)
}

function validateOptions(options: GenerateMediaOptions): MediaOutputKind {
  const model = options.model.trim()
  if (!isSafeModelId(model)) throw new MediaGenerationError("模型 ID 无效", "invalid_model", 400)
  if (!options.prompt.trim() || options.prompt.length > 32_000) {
    throw new MediaGenerationError("媒体生成提示词为空或过长", "invalid_prompt", 400)
  }
  if (options.forceKind === "image" || options.forceKind === "video") {
    return options.forceKind
  }
  if (options.outputKind !== "image" && options.outputKind !== "video") {
    throw new MediaGenerationError("模型用途必须是图片或视频", "unsupported_model", 422)
  }
  // When forceKind is set, trust the caller even if model id is not image-like (Grok reverse proxies).
  const kind = options.outputKind
  // Optional soft check when not forced:
  if (!options.forceKind) {
    // keep outputKind as source of truth (call sites set it explicitly)
  }
  return kind
}


/**
 * Grok reverse-proxy video:
 *   POST {base}/videos/generations  → { request_id }
 *   GET  {base}/videos/{request_id} → { status, progress, video: { url } }
 */
export async function generateGrokProxyVideo(options: GenerateMediaOptions): Promise<GeneratedMedia> {
  const model = options.model.trim()
  if (!isSafeModelId(model)) throw new MediaGenerationError("模型 ID 无效", "invalid_model", 400)
  if (!options.prompt.trim() || options.prompt.length > 32_000) {
    throw new MediaGenerationError("视频生成提示词为空或过长", "invalid_prompt", 400)
  }
  const fetcher = options.fetcher ?? safeModelEndpointFetch
  const apiKey = options.apiKey?.trim() ?? ""
  const createUrl = mediaEndpoint(options.baseUrl, "/videos/generations")
  const creation = await mediaCreationRequest(
    fetcher,
    createUrl,
    authType => ({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...endpointAuthHeaders(apiKey, authType),
      },
      body: JSON.stringify({ model, prompt: options.prompt.trim() }),
      redirect: "manual",
      signal: combineSignal(options.signal, VIDEO_TIMEOUT_MS),
    }),
    apiKey,
    options.authType,
  )
  const { response, raw } = creation
  if (!response.ok) failForResponse(response, raw, apiKey)
  const created = parseJson(raw)
  const requestId = typeof created?.request_id === "string"
    ? created.request_id.trim()
    : typeof created?.id === "string"
      ? created.id.trim()
      : ""
  if (!requestId || requestId.length > 512 || /[^A-Za-z0-9_.:-]/.test(requestId)) {
    // Some proxies may return the video immediately
    const materializeContext: MaterializeContext = { ...options, authType: creation.authType, fetcher }
    const immediate = await videoUrlFromPayload(created, options.prompt, materializeContext)
    if (immediate) return immediate
    throw new MediaGenerationError("视频接口没有返回有效任务 ID", "invalid_job")
  }

  const commonHeaders = endpointAuthHeaders(apiKey, creation.authType)
  const materializeContext: MaterializeContext = { ...options, authType: creation.authType, fetcher }
  const pollBase = mediaEndpoint(options.baseUrl, "/videos")
  const startedAt = Date.now()
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.min(15 * 60_000, Math.max(1, options.timeoutMs!))
    : VIDEO_TIMEOUT_MS
  const pollIntervalMs = Number.isFinite(options.pollIntervalMs)
    ? Math.min(30_000, Math.max(200, options.pollIntervalMs!))
    : 2_000

  while (true) {
    if (options.signal?.aborted) throw options.signal.reason
    if (Date.now() - startedAt >= timeoutMs) {
      throw new MediaGenerationError("视频生成等待超时", "generation_timeout", 504)
    }
    const poll = await endpointRequest(
      fetcher,
      `${pollBase}/${encodeURIComponent(requestId)}`,
      {
        headers: { Accept: "application/json", ...commonHeaders },
        redirect: "manual",
        signal: combineSignal(options.signal),
      },
      apiKey,
    )
    const pollRaw = await readLimitedText(poll)
    // 202 pending is normal for this proxy
    if (poll.status !== 200 && poll.status !== 202) failForResponse(poll, pollRaw, apiKey)
    const job = parseJson(pollRaw)
    const status = String(job?.status ?? "").toLowerCase()
    if (["failed", "cancelled", "canceled", "error"].includes(status)) {
      const detail = responseErrorMessage(JSON.stringify(job), apiKey)
      throw new MediaGenerationError(`视频生成失败${detail ? `：${detail}` : ""}`, "generation_failed", 422)
    }
    if (status === "done" || status === "completed" || status === "succeeded" || status === "success") {
      const url = typeof job?.video?.url === "string"
        ? job.video.url
        : typeof job?.url === "string"
          ? job.url
          : ""
      if (url) return materializeMediaUrl(url, "video", options.prompt, materializeContext)
      const via = await videoUrlFromPayload(job, options.prompt, materializeContext)
      if (via) return via
      throw new MediaGenerationError("视频已完成但未返回地址", "empty_response")
    }
    // pending / processing
    await waitForPoll(pollIntervalMs, options.signal)
  }
}

export async function generateOpenAICompatibleMedia(options: GenerateMediaOptions): Promise<GeneratedMedia> {
  const kind = validateOptions(options)
  if (kind === "image") return generateOpenAICompatibleImage({ ...options, outputKind: "image", forceKind: "image" })
  if (kind === "video") {
    // Prefer Grok reverse-proxy async video API; fall back to OpenAI-style /videos
    try {
      return await generateGrokProxyVideo({ ...options, outputKind: "video", forceKind: "video" })
    } catch (error) {
      if (error instanceof MediaGenerationError && (error.code === "media_not_found" || error.status === 404)) {
        return generateOpenAICompatibleVideo(options)
      }
      // If proxy uses /videos/generations, grok path is correct even on other errors
      throw error
    }
  }
  throw new MediaGenerationError("所选模型不是可识别的图片或视频模型", "unsupported_model", 422)
}
