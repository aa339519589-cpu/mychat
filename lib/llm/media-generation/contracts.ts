import type { EndpointAuthType } from '@/lib/model-endpoints'
import { isSafeModelId } from '@/lib/model-endpoints'

export const MAX_JSON_BYTES = 16 * 1024 * 1024
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024 - 1024
export const MAX_VIDEO_BYTES = 12 * 1024 * 1024 - 1024
export const MAX_MEDIA_URL_LENGTH = 8 * 1024
export const REQUEST_TIMEOUT_MS = 60_000
export const IMAGE_GENERATION_TIMEOUT_MS = 5 * 60_000
export const VIDEO_TIMEOUT_MS = 5 * 60_000
export const VIDEO_POLL_INTERVAL_MS = 2_000

export const DEFAULT_IMAGE_EDIT_PROMPT = '基于这张参考图创作一张新的高质量图片'
export const DEFAULT_IMAGE_TO_VIDEO_PROMPT = '让画面自然生动地动起来'

export type ModelEndpointFetcher = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>

export type MediaOutputKind = 'image' | 'video'

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
  /** Optional reference image for image edit or image-to-video. */
  sourceImage?: string
  signal?: AbortSignal
  /** Tests may inject a fetcher; production defaults to the SSRF-safe fetcher. */
  fetcher?: ModelEndpointFetcher
  pollIntervalMs?: number
  timeoutMs?: number
  /** Supports platform reverse-proxy model IDs without media-name heuristics. */
  forceKind?: MediaOutputKind
  /** Stable job-scoped key used only on provider creation requests. */
  idempotencyKey?: string
}

export type MaterializeContext = Pick<
  GenerateMediaOptions,
  'baseUrl' | 'apiKey' | 'authType' | 'signal'
> & { fetcher: ModelEndpointFetcher }

export class MediaGenerationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status = 502,
  ) {
    super(message)
    this.name = 'MediaGenerationError'
  }
}

export function combineMediaGenerationSignals(
  requestSignal: AbortSignal,
  cancellationSignal: AbortSignal,
): AbortSignal {
  if (requestSignal.aborted) return requestSignal
  if (cancellationSignal.aborted) return cancellationSignal
  return AbortSignal.any([requestSignal, cancellationSignal])
}

export function normalizeSourceImage(value: string | undefined | null): string | undefined {
  const url = (value ?? '').trim()
  if (!url) return undefined
  if (url.startsWith('data:image/')) return url
  if (/^https:\/\//i.test(url)) return url
  return undefined
}

export function resolveMediaPrompt(options: GenerateMediaOptions, kind: MediaOutputKind): string {
  const prompt = options.prompt.trim()
  if (prompt) return prompt.slice(0, 32_000)
  if (normalizeSourceImage(options.sourceImage)) {
    return kind === 'video' ? DEFAULT_IMAGE_TO_VIDEO_PROMPT : DEFAULT_IMAGE_EDIT_PROMPT
  }
  return ''
}

export function validateOptions(options: GenerateMediaOptions): MediaOutputKind {
  const model = options.model.trim()
  if (!isSafeModelId(model)) throw new MediaGenerationError('模型 ID 无效', 'invalid_model', 400)
  const kind = options.forceKind === 'image' || options.forceKind === 'video'
    ? options.forceKind
    : options.outputKind
  if (kind !== 'image' && kind !== 'video') {
    throw new MediaGenerationError('模型用途必须是图片或视频', 'unsupported_model', 422)
  }
  const hasSource = Boolean(normalizeSourceImage(options.sourceImage))
  const prompt = resolveMediaPrompt(options, kind)
  if ((!prompt || prompt.length > 32_000) && !hasSource) {
    throw new MediaGenerationError('请输入描述，或附上参考图', 'invalid_prompt', 400)
  }
  if (options.prompt.trim().length > 32_000) {
    throw new MediaGenerationError('媒体生成提示词过长', 'invalid_prompt', 400)
  }
  return kind
}
