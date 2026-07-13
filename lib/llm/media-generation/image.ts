import { isSafeModelId } from '@/lib/model-endpoints'
import { safeModelEndpointFetch } from '../openai-compatible'
import {
  IMAGE_GENERATION_TIMEOUT_MS,
  MediaGenerationError,
  normalizeSourceImage,
  resolveMediaPrompt,
  type GenerateMediaOptions,
  type MaterializeContext,
} from './contracts'
import { imageFromPayload } from './materialize'
import {
  combineMediaSignal,
  endpointAuthHeaders,
  failForResponse,
  mediaCreationRequest,
  mediaEndpoint,
  parseImageSsePayloads,
  parseMediaJson,
} from './transport'

export async function generateOpenAICompatibleImage(options: GenerateMediaOptions) {
  if (options.forceKind !== 'image' && options.outputKind !== 'image') {
    throw new MediaGenerationError('所选模型不是可识别的图片模型', 'unsupported_model', 422)
  }
  const model = options.model.trim()
  if (!isSafeModelId(model)) throw new MediaGenerationError('模型 ID 无效', 'invalid_model', 400)
  const sourceImage = normalizeSourceImage(options.sourceImage)
  const prompt = resolveMediaPrompt(options, 'image')
  if (!prompt || prompt.length > 32_000) {
    throw new MediaGenerationError(
      sourceImage ? '图片编辑提示词无效' : '请输入图片描述，或附上参考图',
      'invalid_prompt',
      400,
    )
  }

  const fetcher = options.fetcher ?? safeModelEndpointFetch
  const apiKey = options.apiKey?.trim() ?? ''
  const path = sourceImage ? '/images/edits' : '/images/generations'
  const body: Record<string, unknown> = sourceImage
    ? { model, prompt, image: { url: sourceImage, type: 'image_url' } }
    : {
        model,
        prompt,
        n: 1,
        size: /(?:^|[-_.\/])seedream[-_.]?5(?=$|[-_.\/\d])/i.test(model)
          ? '2048x2048'
          : '1024x1024',
      }
  const creation = await mediaCreationRequest(
    fetcher,
    mediaEndpoint(options.baseUrl, path),
    authType => ({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...endpointAuthHeaders(apiKey, authType),
      },
      body: JSON.stringify(body),
      redirect: 'manual',
      signal: combineMediaSignal(options.signal, IMAGE_GENERATION_TIMEOUT_MS),
    }),
    apiKey,
    options.authType,
  )
  const { response, raw } = creation
  if (!response.ok) failForResponse(response, raw, apiKey)
  const context: MaterializeContext = { ...options, authType: creation.authType, fetcher }
  const payloads = response.headers.get('content-type')?.includes('text/event-stream')
    || /^\s*(?:event|data):/m.test(raw)
    ? parseImageSsePayloads(raw)
    : [parseMediaJson(raw)]
  for (let index = payloads.length - 1; index >= 0; index--) {
    const media = await imageFromPayload(payloads[index], prompt, context)
    if (media) return media
  }
  throw new MediaGenerationError('图片接口已响应，但没有返回图片', 'empty_response')
}
