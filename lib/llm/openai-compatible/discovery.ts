import {
  isLikelyChatModel,
  isSafeModelId,
  modelDisplayName,
  type DiscoveredModel,
  type EndpointAuthType,
} from '@/lib/model-endpoints'
import {
  CONNECT_TIMEOUT_MS,
  MAX_MODEL_ID,
  MAX_MODELS,
  ModelEndpointError,
} from './contracts'
import {
  endpointAuthHeaders,
  modelListUrlCandidates,
  normalizeOpenAIBaseUrl,
} from './policy'
import { readLimitedText, upstreamMessage } from './response'
import { safeModelEndpointFetch } from './safe-fetch'

function parseModels(raw: string, apiKey: string): DiscoveredModel[] {
  let payload: any
  try { payload = JSON.parse(raw) } catch {
    throw new ModelEndpointError('模型列表不是有效 JSON', 'models', 'invalid_json', 502)
  }
  const source = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : payload?.models
  if (!Array.isArray(source)) {
    throw new ModelEndpointError(
      '模型列表格式不兼容，未找到 data[] 或 models[]',
      'models',
      'invalid_shape',
      502,
    )
  }

  const seen = new Set<string>()
  const models: DiscoveredModel[] = []
  for (const item of source) {
    const rawId = typeof item === 'string' ? item : item?.id ?? item?.name
    if (typeof rawId !== 'string') continue
    const id = rawId.replace(/[\u0000-\u001f\u007f]/g, '').trim()
    if (!isSafeModelId(id, apiKey) || id.length > MAX_MODEL_ID || seen.has(id)) continue
    seen.add(id)
    models.push({
      id,
      displayName: modelDisplayName(
        id,
        typeof item === 'object' ? item?.display_name ?? item?.displayName : undefined,
        apiKey,
      ),
      ...(typeof item?.owned_by === 'string' ? { ownedBy: item.owned_by.slice(0, 100) } : {}),
      chatCompatible: isLikelyChatModel(id),
    })
    if (models.length >= MAX_MODELS) break
  }
  if (!models.length) {
    throw new ModelEndpointError('服务返回了空模型列表', 'models', 'empty_models', 422)
  }
  return models
}

type DiscoverOptions = {
  baseUrl: string
  apiKey?: string
  authType?: EndpointAuthType | 'auto'
  signal?: AbortSignal
}

export async function discoverOpenAIModels(options: DiscoverOptions): Promise<{
  baseUrl: string
  authType: EndpointAuthType
  models: DiscoveredModel[]
}> {
  const baseUrl = normalizeOpenAIBaseUrl(options.baseUrl)
  const apiKey = options.apiKey?.trim() ?? ''
  const authTypes: EndpointAuthType[] = options.authType && options.authType !== 'auto'
    ? [options.authType]
    : apiKey ? ['bearer', 'x-api-key', 'api-key', 'none'] : ['none']
  let lastError: ModelEndpointError | null = null

  for (const authType of authTypes) {
    let authenticationError: ModelEndpointError | null = null
    const urls = modelListUrlCandidates(baseUrl)
    for (let urlIndex = 0; urlIndex < urls.length; urlIndex++) {
      const url = urls[urlIndex]
      let response: Response
      try {
        const signals = [options.signal, AbortSignal.timeout(CONNECT_TIMEOUT_MS)]
          .filter(Boolean) as AbortSignal[]
        response = await safeModelEndpointFetch(url, {
          headers: { Accept: 'application/json', ...endpointAuthHeaders(apiKey, authType) },
          redirect: 'manual',
          signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
        })
      } catch (error) {
        if (options.signal?.aborted) throw error
        if (error instanceof ModelEndpointError) throw error
        lastError = new ModelEndpointError(
          error instanceof Error && error.name === 'TimeoutError'
            ? '连接模型服务超时'
            : '无法连接模型服务，请检查地址和网络',
          'network',
          'connect_failed',
          502,
        )
        continue
      }
      const raw = await readLimitedText(response)
      if (response.status >= 300 && response.status < 400) {
        throw new ModelEndpointError(
          '模型服务返回了重定向，出于凭据安全已停止',
          'models',
          'redirect_blocked',
          502,
        )
      }
      if (response.ok) {
        const discoveredBaseUrl = url === `${baseUrl}/v1/models` ? `${baseUrl}/v1` : baseUrl
        try {
          return { baseUrl: discoveredBaseUrl, authType, models: parseModels(raw, apiKey) }
        } catch (error) {
          const canTryNextUrl = error instanceof ModelEndpointError
            && ['invalid_json', 'invalid_shape', 'empty_models'].includes(error.code)
            && urlIndex < urls.length - 1
          if (!canTryNextUrl) throw error
          lastError = error
          continue
        }
      }
      if (response.status === 401 || response.status === 403) {
        authenticationError = new ModelEndpointError(
          'API Key 被模型服务拒绝，请检查 Key 和权限',
          'models',
          'auth_failed',
          response.status,
        )
        lastError = authenticationError
        continue
      }
      if (response.status === 404 || response.status === 405) {
        lastError = new ModelEndpointError(
          '没有找到模型列表接口',
          'models',
          'models_not_found',
          response.status,
        )
        continue
      }
      const detail = upstreamMessage(raw, [apiKey])
      throw new ModelEndpointError(
        `获取模型失败（${response.status}）${detail ? `：${detail}` : ''}`,
        'models',
        'upstream_error',
        response.status,
      )
    }
    if (!authenticationError) {
      throw lastError
        ?? new ModelEndpointError('无法获取模型列表', 'models', 'discovery_failed', 502)
    }
    lastError = authenticationError
  }
  throw lastError
    ?? new ModelEndpointError('无法获取模型列表', 'models', 'discovery_failed', 502)
}
