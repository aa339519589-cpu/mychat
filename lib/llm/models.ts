import type { EndpointAuthType } from '@/lib/model-endpoints'
import type { ModelAccessClass, ModelCatalogItem } from '@/lib/model-catalog'
import { customModelReasoningProfile } from '@/lib/model-reasoning'
import { anthropicMessagesUrl } from './anthropic-messages'
import type { ProviderAdapterId } from './provider-adapters'

export type PlatformApiKeyEnv = 'DEEPSEEK_API_KEY' | 'MIMO_API_KEY' | 'DEEP_TIER_API_KEY' | 'OPENROUTER_API_KEY'

export type ModelCapability = {
  id: string
  supportsVision: boolean
  supportsImageInput: boolean
  maxContext: number
  supportsThinking: boolean
  provider: {
    id: 'deepseek' | 'xiaomi-mimo' | 'custom' | 'deep-tier' | 'openrouter' | 'anthropic'
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
    defaultReasoningEffort: 'none',
  },
  'deepseek/deepseek-v4-pro': {
    catalogId: 'deepseek/deepseek-v4-pro',
    runtimeModel: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    access: 'quota',
    outputKind: 'chat',
    tools: true,
    reasoningEfforts: DEEPSEEK_REASONING_EFFORTS,
    defaultReasoningEffort: 'none',
  },
}

export function getDirectDeepSeekCatalogRoute(modelId: string): DirectDeepSeekCatalogRoute | null {
  return DIRECT_DEEPSEEK_CATALOG_ROUTES[modelId] ?? null
}

export type SharedClaudeCatalogRoute = {
  catalogId: string
  defaultRuntimeModel: string
  runtimeModelEnv: string
  name: string
  access: 'premium'
  outputKind: 'chat'
  tools: true
  reasoningEfforts: readonly string[]
  defaultReasoningEffort: string
  reasoningMandatory: boolean
}

const SHARED_CLAUDE_REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const

const SHARED_CLAUDE_CATALOG_ROUTES: Record<string, SharedClaudeCatalogRoute> = {
  'anthropic/claude-fable-5.1': {
    catalogId: 'anthropic/claude-fable-5.1', defaultRuntimeModel: 'claude-fable-5-1',
    runtimeModelEnv: 'CLAUDE_FABLE_51_MODEL', name: 'Claude Fable 5.1', access: 'premium',
    outputKind: 'chat', tools: true, reasoningEfforts: SHARED_CLAUDE_REASONING_EFFORTS.filter(effort => effort !== 'none'),
    defaultReasoningEffort: 'high', reasoningMandatory: true,
  },
  'anthropic/claude-opus-5.5': {
    catalogId: 'anthropic/claude-opus-5.5', defaultRuntimeModel: 'claude-opus-5-5',
    runtimeModelEnv: 'CLAUDE_OPUS_55_MODEL', name: 'Claude Opus 5.5', access: 'premium',
    outputKind: 'chat', tools: true, reasoningEfforts: SHARED_CLAUDE_REASONING_EFFORTS,
    defaultReasoningEffort: 'high', reasoningMandatory: false,
  },
  'anthropic/claude-sonnet-5.5': {
    catalogId: 'anthropic/claude-sonnet-5.5', defaultRuntimeModel: 'claude-sonnet-5-5',
    runtimeModelEnv: 'CLAUDE_SONNET_55_MODEL', name: 'Claude Sonnet 5.5', access: 'premium',
    outputKind: 'chat', tools: true, reasoningEfforts: SHARED_CLAUDE_REASONING_EFFORTS,
    defaultReasoningEffort: 'high', reasoningMandatory: false,
  },
  'anthropic/claude-haiku-5.5': {
    catalogId: 'anthropic/claude-haiku-5.5', defaultRuntimeModel: 'claude-haiku-5-5',
    runtimeModelEnv: 'CLAUDE_HAIKU_55_MODEL', name: 'Claude Haiku 5.5', access: 'premium',
    outputKind: 'chat', tools: true, reasoningEfforts: SHARED_CLAUDE_REASONING_EFFORTS,
    defaultReasoningEffort: 'medium', reasoningMandatory: false,
  },
}

export function getSharedClaudeCatalogRoute(modelId: string): SharedClaudeCatalogRoute | null {
  return SHARED_CLAUDE_CATALOG_ROUTES[modelId]
    ?? Object.values(SHARED_CLAUDE_CATALOG_ROUTES).find(route => sharedClaudeRuntimeModel(route) === modelId)
    ?? null
}

export function sharedClaudeCatalogRoutes(): readonly SharedClaudeCatalogRoute[] {
  return Object.values(SHARED_CLAUDE_CATALOG_ROUTES)
}

export type SharedClaudeProviderConfig = {
  apiKey: string
  authType: EndpointAuthType
  baseUrl: string
}

function sharedClaudeCredentials(): { apiKey: string; authType: EndpointAuthType } {
  const bearerKey = process.env.CLAUDE_API_KEY?.trim() || process.env.ANTHROPIC_AUTH_TOKEN?.trim() || ''
  const xApiKey = process.env.ANTHROPIC_API_KEY?.trim() || ''
  const apiKey = bearerKey || xApiKey
  const fallbackAuthType: EndpointAuthType = bearerKey ? 'bearer' : 'x-api-key'
  const authType = parseEndpointAuthType(
    process.env.CLAUDE_API_AUTH_TYPE || process.env.ANTHROPIC_AUTH_TYPE,
    fallbackAuthType,
  )
  return { apiKey, authType }
}

export function resolveSharedClaudeProviderConfig(): SharedClaudeProviderConfig | null {
  const baseUrl = process.env.CLAUDE_API_BASE_URL?.trim() || process.env.ANTHROPIC_BASE_URL?.trim() || ''
  const credentials = sharedClaudeCredentials()
  if (!baseUrl || !credentials.apiKey) return null
  return { ...credentials, baseUrl: anthropicMessagesUrl(baseUrl) }
}

export function sharedClaudeRuntimeModel(route: SharedClaudeCatalogRoute): string {
  return process.env[route.runtimeModelEnv]?.trim() || route.defaultRuntimeModel
}

export function sharedClaudeModelCapability(
  route: SharedClaudeCatalogRoute,
  config: SharedClaudeProviderConfig,
): ModelCapability {
  return {
    id: sharedClaudeRuntimeModel(route),
    supportsVision: true,
    supportsImageInput: true,
    maxContext: 1_000_000,
    supportsThinking: true,
    provider: {
      id: 'anthropic',
      adapter: 'anthropic-messages',
      baseUrl: config.baseUrl,
      authType: config.authType,
    },
  }
}

function parseEndpointAuthType(raw: string | undefined, fallback: EndpointAuthType = 'bearer'): EndpointAuthType {
  const normalized = (raw ?? fallback).trim().toLowerCase()
  if (normalized === 'x-api-key' || normalized === 'api-key' || normalized === 'none' || normalized === 'bearer') return normalized
  return fallback
}
function readDeepTierAuthType(): EndpointAuthType { return parseEndpointAuthType(process.env.DEEP_TIER_AUTH_TYPE) }
export function resolveDeepTierCapability(): ModelCapability { return { ...MODEL_REGISTRY['deepseek-v4-pro'] } }
export function getModelCapability(model: string): ModelCapability { if (model === PLATFORM_DEEP_MODEL_KEY) return resolveDeepTierCapability(); return MODEL_REGISTRY[model as keyof typeof MODEL_REGISTRY] ?? MODEL_REGISTRY['deepseek-v4-flash'] }
export function customModelCapability(model: string, baseUrl: string): ModelCapability {
  const profile = customModelReasoningProfile(model)
  const adapter = profile.transport === 'anthropic' ? 'anthropic-messages' : 'generic-openai'
  return {
    id: model,
    supportsVision: true,
    supportsImageInput: true,
    maxContext: 128_000,
    supportsThinking: profile.reasoningEfforts.length > 0,
    provider: {
      id: 'custom',
      adapter,
      baseUrl: adapter === 'anthropic-messages' ? anthropicMessagesUrl(baseUrl) : baseUrl,
    },
  }
}

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
