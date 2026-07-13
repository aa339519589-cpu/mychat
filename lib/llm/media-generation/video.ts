import type { GeneratedMedia } from '@/lib/generated-media'
import { isSafeModelId } from '@/lib/model-endpoints'
import { normalizeOpenAIBaseUrl, safeModelEndpointFetch } from '../openai-compatible'
import {
  DEFAULT_IMAGE_TO_VIDEO_PROMPT,
  MediaGenerationError,
  normalizeSourceImage,
  resolveMediaPrompt,
  validateOptions,
  VIDEO_POLL_INTERVAL_MS,
  VIDEO_TIMEOUT_MS,
  type GenerateMediaOptions,
  type MaterializeContext,
} from './contracts'
import { materializeMediaUrl, readVideoContent, videoUrlFromPayload } from './materialize'
import {
  combineMediaSignal,
  endpointAuthHeaders,
  endpointRequest,
  failForResponse,
  mediaCreationRequest,
  mediaEndpoint,
  parseMediaJson,
  readLimitedText,
  redactMediaError,
  responseErrorMessage,
  waitForMediaPoll,
} from './transport'

function videoTiming(options: GenerateMediaOptions, minimumPollMs: number) {
  return {
    timeoutMs: Number.isFinite(options.timeoutMs)
      ? Math.min(15 * 60_000, Math.max(1, options.timeoutMs!))
      : VIDEO_TIMEOUT_MS,
    pollIntervalMs: Number.isFinite(options.pollIntervalMs)
      ? Math.min(30_000, Math.max(minimumPollMs, options.pollIntervalMs!))
      : VIDEO_POLL_INTERVAL_MS,
  }
}

function failedVideoJob(job: any, apiKey: string): never {
  const detail = responseErrorMessage(JSON.stringify(job), apiKey)
    || (typeof job?.error === 'string' ? redactMediaError(job.error, apiKey) : '')
  throw new MediaGenerationError(`视频生成失败${detail ? `：${detail}` : ''}`, 'generation_failed', 422)
}

function validJobId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : ''
  return id && id.length <= 512 && !/[^A-Za-z0-9_.:-]/.test(id) ? id : ''
}

export async function generateOpenAICompatibleVideo(
  options: GenerateMediaOptions,
): Promise<GeneratedMedia> {
  const kind = validateOptions(options)
  if (kind !== 'video') {
    throw new MediaGenerationError('所选模型不是可识别的视频模型', 'unsupported_model', 422)
  }
  const fetcher = options.fetcher ?? safeModelEndpointFetch
  const apiKey = options.apiKey?.trim() ?? ''
  const normalizedBaseUrl = normalizeOpenAIBaseUrl(options.baseUrl)
  const baseUrl = new URL(normalizedBaseUrl).pathname === '/' ? `${normalizedBaseUrl}/v1` : normalizedBaseUrl
  const creation = await mediaCreationRequest(
    fetcher,
    `${baseUrl}/videos`,
    authType => ({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...endpointAuthHeaders(apiKey, authType),
      },
      body: JSON.stringify({
        model: options.model.trim(),
        prompt: options.prompt.trim(),
        size: '1280x720',
        seconds: '4',
      }),
      redirect: 'manual',
      signal: combineMediaSignal(options.signal),
    }),
    apiKey,
    options.authType,
  )
  const { response: create, raw: createRaw } = creation
  if (!create.ok) failForResponse(create, createRaw, apiKey)
  const commonHeaders = endpointAuthHeaders(apiKey, creation.authType)
  const context: MaterializeContext = { ...options, authType: creation.authType, fetcher }
  let job = parseMediaJson(createRaw)
  const immediate = await videoUrlFromPayload(job, options.prompt, context)
  if (immediate) return immediate

  const id = validJobId(job?.id)
  if (!id) throw new MediaGenerationError('视频接口没有返回有效任务 ID', 'invalid_job')
  const startedAt = Date.now()
  const { timeoutMs, pollIntervalMs } = videoTiming(options, 0)
  while (true) {
    const status = String(job?.status ?? '').toLowerCase()
    if (['failed', 'cancelled', 'canceled', 'error'].includes(status)) failedVideoJob(job, apiKey)
    if (['completed', 'succeeded', 'success', 'done'].includes(status)) break
    if (Date.now() - startedAt >= timeoutMs) {
      throw new MediaGenerationError('视频生成等待超时', 'generation_timeout', 504)
    }
    await waitForMediaPoll(
      Math.min(pollIntervalMs, Math.max(0, timeoutMs - (Date.now() - startedAt))),
      options.signal,
    )
    const poll = await endpointRequest(fetcher, `${baseUrl}/videos/${encodeURIComponent(id)}`, {
      headers: { Accept: 'application/json', ...commonHeaders },
      redirect: 'manual',
      signal: combineMediaSignal(options.signal),
    }, apiKey)
    const pollRaw = await readLimitedText(poll)
    if (!poll.ok) failForResponse(poll, pollRaw, apiKey)
    job = parseMediaJson(pollRaw)
    const direct = await videoUrlFromPayload(job, options.prompt, context)
    if (direct) return direct
  }

  const direct = await videoUrlFromPayload(job, options.prompt, context)
  if (direct) return direct
  const content = await endpointRequest(fetcher, `${baseUrl}/videos/${encodeURIComponent(id)}/content`, {
    headers: { Accept: 'video/*, application/octet-stream', ...commonHeaders },
    redirect: 'manual',
    signal: combineMediaSignal(options.signal),
  }, apiKey)
  return readVideoContent(content, options.prompt, apiKey)
}

/** xAI/Grok reverse-proxy asynchronous video protocol. */
export async function generateGrokProxyVideo(options: GenerateMediaOptions): Promise<GeneratedMedia> {
  const model = options.model.trim()
  if (!isSafeModelId(model)) throw new MediaGenerationError('模型 ID 无效', 'invalid_model', 400)
  const sourceImage = normalizeSourceImage(options.sourceImage)
  const prompt = resolveMediaPrompt(options, 'video')
  if (!prompt && !sourceImage) {
    throw new MediaGenerationError('请输入视频描述，或附上参考图', 'invalid_prompt', 400)
  }
  if (options.prompt.trim().length > 32_000) {
    throw new MediaGenerationError('视频生成提示词过长', 'invalid_prompt', 400)
  }

  const fetcher = options.fetcher ?? safeModelEndpointFetch
  const apiKey = options.apiKey?.trim() ?? ''
  const requestBody: Record<string, unknown> = {
    model,
    prompt: prompt || DEFAULT_IMAGE_TO_VIDEO_PROMPT,
  }
  if (sourceImage) requestBody.image = { url: sourceImage }
  const creation = await mediaCreationRequest(
    fetcher,
    mediaEndpoint(options.baseUrl, '/videos/generations'),
    authType => ({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...endpointAuthHeaders(apiKey, authType),
      },
      body: JSON.stringify(requestBody),
      redirect: 'manual',
      signal: combineMediaSignal(options.signal, VIDEO_TIMEOUT_MS),
    }),
    apiKey,
    options.authType,
  )
  const { response, raw } = creation
  if (!response.ok) failForResponse(response, raw, apiKey)
  const created = parseMediaJson(raw)
  const requestId = validJobId(created?.request_id ?? created?.id)
  const context: MaterializeContext = { ...options, authType: creation.authType, fetcher }
  const alt = prompt || DEFAULT_IMAGE_TO_VIDEO_PROMPT
  if (!requestId) {
    const immediate = await videoUrlFromPayload(created, alt, context)
    if (immediate) return immediate
    throw new MediaGenerationError('视频接口没有返回有效任务 ID', 'invalid_job')
  }

  const commonHeaders = endpointAuthHeaders(apiKey, creation.authType)
  const pollBase = mediaEndpoint(options.baseUrl, '/videos')
  const startedAt = Date.now()
  const { timeoutMs, pollIntervalMs } = videoTiming(options, 200)
  while (true) {
    if (options.signal?.aborted) throw options.signal.reason
    if (Date.now() - startedAt >= timeoutMs) {
      throw new MediaGenerationError('视频生成等待超时', 'generation_timeout', 504)
    }
    const poll = await endpointRequest(fetcher, `${pollBase}/${encodeURIComponent(requestId)}`, {
      headers: { Accept: 'application/json', ...commonHeaders },
      redirect: 'manual',
      signal: combineMediaSignal(options.signal),
    }, apiKey)
    const pollRaw = await readLimitedText(poll)
    if (poll.status !== 200 && poll.status !== 202) failForResponse(poll, pollRaw, apiKey)
    const job = parseMediaJson(pollRaw)
    const status = String(job?.status ?? '').toLowerCase()
    if (['failed', 'cancelled', 'canceled', 'error'].includes(status)) failedVideoJob(job, apiKey)
    if (['done', 'completed', 'succeeded', 'success'].includes(status)) {
      const url = typeof job?.video?.url === 'string'
        ? job.video.url
        : typeof job?.url === 'string' ? job.url : ''
      if (url) return materializeMediaUrl(url, 'video', alt, context)
      const via = await videoUrlFromPayload(job, alt, context)
      if (via) return via
      throw new MediaGenerationError('视频已完成但未返回地址', 'empty_response')
    }
    await waitForMediaPoll(pollIntervalMs, options.signal)
  }
}
