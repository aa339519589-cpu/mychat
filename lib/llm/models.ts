import type { EndpointAuthType } from '@/lib/model-endpoints'
import type { ModelAccessClass, ModelCatalogItem } from '@/lib/model-catalog'
import type { ProviderAdapterId } from './provider-adapters'

export type PlatformApiKeyEnv = 'DEEPSEEK_API_KEY' | 'MIMO_API_KEY' | 'DEEP_TIER_API_KEY' | 'OPENROUTER_API_KEY'

export type ModelCapability = {
  id: string
  supportsVision: boolean
  supportsImageInput: boolean
  maxContext: number
  supportsThinking: boolean
  provider: {
    id: 'deepseek' | 'xiaomi-mimo' | 'custom' | 'deep-tier' | 'openrouter'
    adapter: ProviderAdapterId
    baseUrl: string
    apiKeyEnv?: PlatformApiKeyEnv
    authType?: EndpointAuthType
  }
}

export const PLATFORM_DEEP_MODEL_KEY = 'platform-deep'

export const MODEL_REGISTRY = {
  'deepseek-v4-flash': {
    id: 'deepseek-v4-flash', supportsVision: false, supportsImageInput: false, maxContext: 128_000, supportsThinking: true,
    provider: { id: 'deepseek', adapter: 'deepseek-openai', baseUrl: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY' },
  },
  'deepseek-v4-pro': {
    id: 'deepseek-v4-pro', supportsVision: false, supportsImageInput: false, maxContext: 128_000, supportsThinking: true,
    provider: { id: 'deepseek', adapter: 'deepseek-openai', baseUrl: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY' },
  },
  'mimo-v2.5': {
    id: 'mimo-v2.5', supportsVision: true, supportsImageInput: true, maxContext: 1_000_000, supportsThinking: false,
    provider: { id: 'xiaomi-mimo', adapter: 'mimo-openai', baseUrl: 'https://api.xiaomimimo.com', apiKeyEnv: 'MIMO_API_KEY' },
  },
} as const satisfies Record<string, ModelCapability>

export type DirectDeepSeekCatalogRoute = {
  catalogId: string
  runtimeModel: keyof typeof MODEL_REGISTRY
  name: string
  access: ModelAccessClass
  outputKind: 'chat'
  tools: true
  reasoningEfforts: readonly string[]
  defaultReasoningEffort: string
}

const DEEPSEEK_REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

const DIRECT_DEEPSEEK_CATALOG_ROUTES: Record<string, DirectDeepSeekCatalogRoute> = {
  'deepseek/deepseek-v4-flash-0731': {
    catalogId: 'deepseek/deepseek-v4-flash-0731',
    runtimeModel: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    access: 'quota',
    outputKind: 'chat',
    tools: true,
    reasoningEfforts: DEEPSEEK_REASONING_EFFORTS,
    defaultReasoningEffort: 'high',
  },
  'deepseek/deepseek-v4-pro': {
    catalogId: 'deepseek/deepseek-v4-pro',
    runtimeModel: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    access: 'quota',
    outputKind: 'chat',
    tools: true,
    reasoningEfforts: DEEPSEEK_REASONING_EFFORTS,
    defaultReasoningEffort: 'high',
  },
}

export function getDirectDeepSeekCatalogRoute(modelId: string): DirectDeepSeekCatalogRoute | null {
  return DIRECT_DEEPSEEK_CATALOG_ROUTES[modelId] ?? null
}

function parseEndpointAuthType(raw: string | undefined, fallback: EndpointAuthType = 'bearer'): EndpointAuthType {
  const normalized = (raw ?? fallback).trim().toLowerCase()
  if (normalized === 'x-api-key' || normalized === 'api-key' || normalized === 'none' || normalized === 'bearer') return normalized
  return fallback
}
function readDeepTierAuthType(): EndpointAuthType { return parseEndpointAuthType(process.env.DEEP_TIER_AUTH_TYPE) }
export function resolveDeepTierCapability(): ModelCapability { return { ...MODEL_REGISTRY['deepseek-v4-pro'] } }
export function getModelCapability(model: string): ModelCapability { if (model === PLATFORM_DEEP_MODEL_KEY) return resolveDeepTierCapability(); return MODEL_REGISTRY[model as keyof typeof MODEL_REGISTRY] ?? MODEL_REGISTRY['deepseek-v4-flash'] }
export function customModelCapability(model: string, baseUrl: string): ModelCapability { return { id: model, supportsVision: true, supportsImageInput: true, maxContext: 128_000, supportsThinking: false, provider: { id: 'custom', adapter: 'generic-openai', baseUrl } } }

export function openRouterModelCapability(model: ModelCatalogItem): ModelCapability {
  return {
    id: model.id,
    supportsVision: model.vision,
    supportsImageInput: model.vision,
    maxContext: model.contextLength || 128_000,
    supportsThinking: model.reasoningEfforts.length > 0,
    provider: {
      id: 'openrouter',
      adapter: 'openrouter-openai',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKeyEnv: 'OPENROUTER_API_KEY',
      authType: 'bearer',
    },
  }
}

type PlatformMediaTransport = { baseUrl: string; apiKey: string; authType: EndpointAuthType }
type PlatformMediaPrefix = 'DEEP_TIER_IMAGE' | 'DEEP_TIER_VIDEO'
function resolvePlatformMediaTransport(prefix: PlatformMediaPrefix): PlatformMediaTransport | null {
  const baseUrl = process.env[`${prefix}_BASE_URL`]?.trim() || process.env.DEEP_TIER_BASE_URL?.trim()
  const apiKey = process.env[`${prefix}_API_KEY`]?.trim() || process.env.DEEP_TIER_API_KEY?.trim()
  const authType = parseEndpointAuthType(process.env[`${prefix}_AUTH_TYPE`], readDeepTierAuthType())
  if (!baseUrl || (!apiKey && authType !== 'none')) return null
  return { baseUrl, apiKey: apiKey ?? '', authType }
}

export type DeepTierImageConfig = { baseUrl: string; apiKey: string; model: string; authType: EndpointAuthType }
export function resolveDeepTierImageConfig(): DeepTierImageConfig | null {
  const transport = resolvePlatformMediaTransport('DEEP_TIER_IMAGE')
  const model = process.env.DEEP_TIER_IMAGE_MODEL?.trim() || 'grok-imagine-image-quality'
  if (!transport || !model) return null
  return { ...transport, model }
}
export type DeepTierVideoConfig = { baseUrl: string; apiKey: string; model: string; authType: EndpointAuthType }
export function resolveDeepTierVideoConfig(): DeepTierVideoConfig | null {
  const transport = resolvePlatformMediaTransport('DEEP_TIER_VIDEO')
  const model = process.env.DEEP_TIER_VIDEO_MODEL?.trim() || 'grok-imagine-video-1.5'
  if (!transport || !model) return null
  return { ...transport, model }
}
