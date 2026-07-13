import type { GeneratedMedia } from '@/lib/generated-media'
import { normalizeOpenAIBaseUrl, safeModelEndpointFetch } from '../openai-compatible'
import {
  MAX_IMAGE_BYTES,
  MAX_MEDIA_URL_LENGTH,
  MAX_VIDEO_BYTES,
  MediaGenerationError,
  type MaterializeContext,
  type MaterializeGeneratedMediaOptions,
  type MediaOutputKind,
} from './contracts'
import {
  combineMediaSignal,
  endpointAuthHeaders,
  endpointRequest,
  failForResponse,
  readLimitedBytes,
  readLimitedText,
  responseErrorMessage,
} from './transport'

function estimatedBase64Bytes(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor(value.length * 3 / 4) - padding)
}

function normalizedBase64(value: string, maximumBytes: number): string {
  const compact = value.replace(/\s/g, '')
  if (!compact || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1) {
    throw new MediaGenerationError('媒体接口返回了无效 Base64 数据', 'invalid_media')
  }
  if (estimatedBase64Bytes(compact) > maximumBytes) {
    throw new MediaGenerationError('生成的媒体超过大小限制', 'media_too_large')
  }
  return compact
}

function dataUrlMedia(raw: string, expectedType: MediaOutputKind): GeneratedMedia | null {
  const value = raw.trim()
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new MediaGenerationError('媒体接口返回了无效 URL', 'invalid_media_url')
  }
  if (!/^data:/i.test(value)) return null

  const maximum = expectedType === 'image' ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES
  if (value.length > Math.ceil(maximum * 4 / 3) + 128) {
    throw new MediaGenerationError('生成的媒体超过大小限制', 'media_too_large')
  }
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(value)
  const mimeType = match?.[1].toLowerCase()
  const mimeAllowed = expectedType === 'image'
    ? /^image\/(?:png|jpeg|jpg|webp|gif)$/.test(mimeType ?? '')
    : /^video\/(?:mp4|webm|quicktime)$/.test(mimeType ?? '')
  if (!match || !mimeAllowed) {
    throw new MediaGenerationError('媒体接口返回了无效 Data URL', 'invalid_media_url')
  }
  const base64 = normalizedBase64(match[2], maximum)
  return { type: expectedType, url: `data:${mimeType};base64,${base64}`, mimeType }
}

function remoteMediaUrl(raw: string, baseUrl: string): URL {
  const value = raw.trim()
  if (!value || value.length > MAX_MEDIA_URL_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new MediaGenerationError('媒体接口返回了无效 URL', 'invalid_media_url')
  }
  let parsed: URL
  try {
    parsed = new URL(value, `${normalizeOpenAIBaseUrl(baseUrl)}/`)
  } catch {
    throw new MediaGenerationError('媒体接口返回了无效 URL', 'invalid_media_url')
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password || parsed.hash) {
    throw new MediaGenerationError('媒体 URL 协议无效', 'invalid_media_url')
  }
  return parsed
}

function mediaMimeType(type: MediaOutputKind, value: string | null): string | null {
  const mimeType = (value ?? '').split(';', 1)[0].trim().toLowerCase()
  if (type === 'image' && /^image\/(?:png|jpeg|jpg|webp|gif)$/.test(mimeType)) return mimeType
  if (type === 'video' && /^video\/(?:mp4|webm|quicktime)$/.test(mimeType)) return mimeType
  return null
}

function isStablePublicMediaHost(host: string): boolean {
  return host.includes('imgen.x.ai')
    || host.includes('vidgen.x.ai')
    || host.endsWith('.x.ai')
    || host.endsWith('.supabase.co')
    || host.endsWith('.r2.dev')
    || host.endsWith('.amazonaws.com')
    || host.endsWith('.cloudfront.net')
}

export async function materializeMediaUrl(
  raw: string,
  type: MediaOutputKind,
  prompt: string,
  context: MaterializeContext,
): Promise<GeneratedMedia> {
  const embedded = dataUrlMedia(raw, type)
  if (embedded) return { ...embedded, alt: prompt.slice(0, 300) }

  const url = remoteMediaUrl(raw, context.baseUrl)
  const baseOrigin = new URL(normalizeOpenAIBaseUrl(context.baseUrl)).origin
  const apiKey = context.apiKey?.trim() ?? ''
  const sameOrigin = url.origin === baseOrigin
  if (!sameOrigin && isStablePublicMediaHost(url.hostname.toLowerCase())) {
    return {
      type,
      url: url.toString(),
      mimeType: type === 'image' ? 'image/jpeg' : 'video/mp4',
      alt: prompt.slice(0, 300),
    }
  }

  const response = await endpointRequest(context.fetcher, url.toString(), {
    headers: {
      Accept: type === 'image' ? 'image/*' : 'video/*',
      ...(sameOrigin ? endpointAuthHeaders(apiKey, context.authType) : {}),
    },
    redirect: 'manual',
    signal: combineMediaSignal(context.signal),
  }, apiKey)
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined)
    throw new MediaGenerationError('媒体下载返回重定向，出于凭据和网络安全已停止', 'redirect_blocked', 502)
  }
  if (!response.ok) {
    const rawError = await readLimitedText(response)
    const detail = responseErrorMessage(rawError, apiKey)
    throw new MediaGenerationError(
      `媒体下载失败（${response.status}）${detail ? `：${detail}` : ''}`,
      'media_download_failed',
      response.status,
    )
  }
  const mimeType = mediaMimeType(type, response.headers.get('content-type'))
  if (!mimeType) {
    await response.body?.cancel().catch(() => undefined)
    throw new MediaGenerationError('媒体下载响应的 Content-Type 不受支持', 'invalid_media')
  }
  const limit = type === 'image' ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES
  const bytes = await readLimitedBytes(response, limit, type === 'image' ? '生成的图片' : '生成的视频')
  if (!bytes.byteLength) throw new MediaGenerationError('媒体内容为空', 'empty_response')
  return {
    type,
    url: `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`,
    mimeType,
    alt: prompt.slice(0, 300),
  }
}

export async function materializeOpenAICompatibleMedia(
  media: GeneratedMedia,
  options: MaterializeGeneratedMediaOptions,
): Promise<GeneratedMedia> {
  const fetcher = options.fetcher ?? safeModelEndpointFetch
  return materializeMediaUrl(media.url, media.type, media.alt?.trim() ?? '', { ...options, fetcher })
}

export async function imageFromPayload(
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
    if (!candidate || typeof candidate !== 'object') continue
    const b64 = candidate.b64_json ?? candidate.base64 ?? candidate.result
    if (typeof b64 === 'string' && b64.trim()) {
      const mimeType = typeof candidate.mime_type === 'string'
        && /^image\/(?:png|jpeg|jpg|webp|gif)$/i.test(candidate.mime_type)
        ? candidate.mime_type.toLowerCase()
        : 'image/png'
      const encoded = normalizedBase64(b64, MAX_IMAGE_BYTES)
      return { type: 'image', url: `data:${mimeType};base64,${encoded}`, mimeType, alt: prompt.slice(0, 300) }
    }
    if (typeof candidate.url === 'string') {
      return materializeMediaUrl(candidate.url, 'image', prompt, context)
    }
  }
  return null
}

export async function videoUrlFromPayload(
  payload: any,
  prompt: string,
  context: MaterializeContext,
): Promise<GeneratedMedia | null> {
  const candidates = [payload, payload?.data, payload?.output, payload?.result]
    .flatMap(candidate => Array.isArray(candidate) ? candidate : [candidate])
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue
    const rawUrl = candidate.url ?? candidate.video_url ?? candidate.download_url
    if (typeof rawUrl === 'string') return materializeMediaUrl(rawUrl, 'video', prompt, context)
  }
  return null
}

export async function readVideoContent(
  response: Response,
  prompt: string,
  apiKey: string,
): Promise<GeneratedMedia> {
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined)
    throw new MediaGenerationError('视频下载返回重定向，出于凭据和网络安全已停止', 'redirect_blocked', 502)
  }
  if (!response.ok) failForResponse(response, await readLimitedText(response), apiKey)
  const responseType = (response.headers.get('content-type') ?? 'video/mp4').split(';', 1)[0].trim().toLowerCase()
  const mimeType = responseType === 'application/octet-stream' ? 'video/mp4' : responseType
  if (!/^video\/(?:mp4|webm|quicktime)$/.test(mimeType)) {
    throw new MediaGenerationError('视频内容接口没有返回视频', 'invalid_media')
  }
  const bytes = await readLimitedBytes(response, MAX_VIDEO_BYTES, '生成的视频')
  if (!bytes.byteLength) throw new MediaGenerationError('视频内容为空', 'empty_response')
  return {
    type: 'video',
    url: `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`,
    mimeType,
    alt: prompt.slice(0, 300),
  }
}
