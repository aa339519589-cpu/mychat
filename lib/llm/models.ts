import type { EndpointAuthType } from '@/lib/model-endpoints'
import type { ProviderAdapterId } from './provider-adapters'

export type PlatformApiKeyEnv = 'DEEPSEEK_API_KEY' | 'MIMO_API_KEY' | 'DEEP_TIER_API_KEY'

export type ModelCapability = {
  id: string
  supportsVision: boolean
  supportsImageInput: boolean
  maxContext: number
  /** DeepSeek-style thinking param; false for OpenAI-compatible reverse proxies */
  supportsThinking: boolean
  provider: {
    id: 'deepseek' | 'xiaomi-mimo' | 'custom' | 'deep-tier'
    adapter: ProviderAdapterId
    baseUrl: string
    apiKeyEnv?: PlatformApiKeyEnv
    authType?: EndpointAuthType
  }
}

export const PLATFORM_DEEP_MODEL_KEY = 'platform-deep'

export const MODEL_REGISTRY = {
  'deepseek-v4-flash': {
    id: 'deepseek-v4-flash',
    supportsVision: false,
    supportsImageInput: false,
    maxContext: 128_000,
    supportsThinking: true,
    provider: {
      id: 'deepseek',
      adapter: 'deepseek-openai',
      baseUrl: 'https://api.deepseek.com',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
    },
  },
  'deepseek-v4-pro': {
    id: 'deepseek-v4-pro',
    supportsVision: false,
    supportsImageInput: false,
    maxContext: 128_000,
    supportsThinking: true,
    provider: {
      id: 'deepseek',
      adapter: 'deepseek-openai',
      baseUrl: 'https://api.deepseek.com',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
    },
  },
  'mimo-v2.5': {
    id: 'mimo-v2.5',
    supportsVision: true,
    supportsImageInput: true,
    maxContext: 1_000_000,
    supportsThinking: false,
    provider: {
      id: 'xiaomi-mimo',
      adapter: 'mimo-openai',
      baseUrl: 'https://api.xiaomimimo.com',
      apiKeyEnv: 'MIMO_API_KEY',
    },
  },
} as const satisfies Record<string, ModelCapability>

function readDeepTierAuthType(): EndpointAuthType {
  const raw = (process.env.DEEP_TIER_AUTH_TYPE ?? 'bearer').trim().toLowerCase()
  if (raw === 'x-api-key' || raw === 'api-key' || raw === 'none' || raw === 'bearer') return raw
  return 'bearer'
}

/**
 * 「深度」档位：若配置了反代地址 + Key，则走 OpenAI 兼容反代（例如 Grok 4.5）；
 * 否则回退官方 DeepSeek V4 Pro。
 *
 * Env:
 *   DEEP_TIER_BASE_URL  反代根地址，如 https://your-proxy.example/v1
 *   DEEP_TIER_API_KEY   反代 Key
 *   DEEP_TIER_MODEL     反代要求的 model id（默认 grok-4）
 *   DEEP_TIER_AUTH_TYPE bearer | x-api-key | api-key | none（默认 bearer）
 */
export function resolveDeepTierCapability(): ModelCapability {
  const baseUrl = process.env.DEEP_TIER_BASE_URL?.trim()
  const apiKey = process.env.DEEP_TIER_API_KEY?.trim()
  const modelId = process.env.DEEP_TIER_MODEL?.trim() || 'grok-4'

  if (baseUrl && apiKey) {
    return {
      id: modelId,
      supportsVision: true,
      supportsImageInput: true,
      maxContext: 256_000,
      supportsThinking: false,
      provider: {
        id: 'deep-tier',
        adapter: 'generic-openai',
        baseUrl,
        apiKeyEnv: 'DEEP_TIER_API_KEY',
        authType: readDeepTierAuthType(),
      },
    }
  }

  return { ...MODEL_REGISTRY['deepseek-v4-pro'] }
}

export function getModelCapability(model: string): ModelCapability {
  if (model === PLATFORM_DEEP_MODEL_KEY) return resolveDeepTierCapability()
  return MODEL_REGISTRY[model as keyof typeof MODEL_REGISTRY] ?? MODEL_REGISTRY['deepseek-v4-flash']
}

export function customModelCapability(model: string, baseUrl: string): ModelCapability {
  return {
    id: model,
    supportsVision: true,
    supportsImageInput: true,
    maxContext: 128_000,
    supportsThinking: false,
    provider: {
      id: 'custom',
      adapter: 'generic-openai',
      baseUrl,
    },
  }
}

export function isDeepTierProxyConfigured(): boolean {
  return !!(process.env.DEEP_TIER_BASE_URL?.trim() && process.env.DEEP_TIER_API_KEY?.trim())
}
