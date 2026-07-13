import { normalizeGeneratedMedia, type GeneratedMedia } from "@/lib/generated-media"
import { isRecord } from '@/lib/unknown-value'

export const MAX_GENERIC_ERROR_RESPONSE_BYTES = 64 * 1024
// Structured image parts may legally contain a data URL close to the 16 MiB
// media cap. Text itself remains independently limited below.
export const MAX_GENERIC_SUCCESS_RESPONSE_BYTES = 17 * 1024 * 1024
export const MAX_GENERIC_ACCUMULATED_TEXT_CHARS = 1024 * 1024
const GENERIC_RESPONSE_LIMIT_MESSAGE = '模型服务响应超过安全限制，已终止读取。'

export class GenericResponseLimitError extends Error {
  constructor() {
    super(GENERIC_RESPONSE_LIMIT_MESSAGE)
    this.name = 'GenericResponseLimitError'
  }
}

export function mediaFromContentPart(value: unknown): GeneratedMedia | null {
  if (!value || typeof value !== 'object') return null
  const part = value as Record<string, unknown>
  const marker = typeof part.type === 'string' ? part.type.toLowerCase() : ''
  const mediaType: GeneratedMedia['type'] | null = marker.includes('video') || part.video_url || part.video
    ? 'video'
    : marker.includes('image') || part.image_url || part.image || part.b64_json
      ? 'image'
      : null
  if (!mediaType) return null

  const nested = mediaType === 'image' ? part.image_url ?? part.image : part.video_url ?? part.video
  let url = typeof nested === 'string'
    ? nested
    : isRecord(nested) && typeof nested.url === 'string'
      ? nested.url
      : ''
  if (!url && typeof part.url === 'string') url = part.url
  const encoded = typeof part.b64_json === 'string'
    ? part.b64_json
    : marker.includes('image_generation') && typeof part.result === 'string'
      ? part.result
      : ''
  const mimeType = typeof part.mime_type === 'string'
    ? part.mime_type
    : typeof part.mimeType === 'string'
      ? part.mimeType
      : mediaType === 'image' ? 'image/png' : 'video/mp4'
  if (!url && encoded) url = `data:${mimeType};base64,${encoded}`

  return normalizeGeneratedMedia({
    type: mediaType,
    url,
    mimeType,
    alt: typeof part.alt === 'string'
      ? part.alt
      : typeof part.revised_prompt === 'string'
        ? part.revised_prompt
        : undefined,
  })
}

export function declaredResponseBytes(response: Response): number | null {
  const raw = response.headers.get('content-length')
  if (!raw) return null
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : null
}

export async function readLimitedResponseText(response: Response, maxBytes: number): Promise<string> {
  const declared = declaredResponseBytes(response)
  if (declared !== null && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new GenericResponseLimitError()
  }
  if (!response.body) return ''

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new GenericResponseLimitError()
      }
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}
