import type { SupabaseServer } from '@/lib/api/guard'
import { TIER_MAP } from '@/lib/chat-data'
import type { ModelAccessClass } from '@/lib/model-catalog'
import { getOpenRouterModel } from '@/lib/openrouter-catalog'
import {
  endpointAuthType,
  getOwnedModelEndpoint,
  resolveModelEndpointKey,
  type ModelEndpointRow,
} from '@/lib/model-endpoint-server'
import { isModelOutputKind, type EndpointAuthType, type ModelOutputKind } from '@/lib/model-endpoints'
import {
  customModelCapability,
  getDirectDeepSeekCatalogRoute,
  getModelCapability,
  openRouterModelCapability,
  type ModelCapability,
} from '@/lib/llm/models'
import { ModelEndpointError, validateModelEndpointNetwork } from '@/lib/llm/openai-compatible'

export type ChatModelSelection = {
  customEndpoint: boolean
  model: string
  thinking: boolean
  reasoningEffort: string | null
  accessClass: ModelAccessClass | 'legacy'
  capability: ModelCapability
  apiKey: string
  authType?: EndpointAuthType
  outputKind: ModelOutputKind
  endpointDisplayName?: string
  platformTierLabel?: string
}

export class ChatModelSelectionError extends Error {
  constructor(
    public readonly status: number,
    public readonly payload: Record<string, unknown>,
    public readonly rawJson = false,
    public readonly logMessage?: string,
  ) {
    super(typeof payload.error === 'string' ? payload.error : '模型配置不可用')
    this.name = 'ChatModelSelectionError'
  }

  toResponse(): Response {
    return this.rawJson
      ? new Response(JSON.stringify(this.payload), { status: this.status })
      : Response.json(this.payload, { status: this.status })
  }
}

type ResolveChatModelOptions = {
  tier: string
  endpointId?: string
  modelId?: string
  reasoningEffort?: string
  supabase: SupabaseServer | null
  userId: string | null
  allowPremium?: boolean
}

type ModelSelectionDependencies = {
  getOwnedEndpoint: (
    supabase: SupabaseServer,
    userId: string,
    endpointId: string,
  ) => Promise<ModelEndpointRow | null>
  resolveEndpointKey: (endpoint: ModelEndpointRow, userId: string) => string
  validateEndpointNetwork: (baseUrl: string) => Promise<string>
}

const DEFAULT_DEPENDENCIES: ModelSelectionDependencies = {
  getOwnedEndpoint: (supabase, userId, endpointId) => (
    getOwnedModelEndpoint(supabase, userId, endpointId)
  ),
  resolveEndpointKey: resolveModelEndpointKey,
  validateEndpointNetwork: validateModelEndpointNetwork,
}

function requiredEnvironmentKey(environmentName: string | undefined): string {
  const apiKey = environmentName ? process.env[environmentName]?.trim() ?? '' : ''
  if (apiKey) return apiKey
  throw new ChatModelSelectionError(
    500,
    { error: `服务未配置（${environmentName ?? '模型 API Key'} 未设置）` },
    true,
    `${environmentName ?? 'model key'} not configured`,
  )
}

function requestedEffort(
  value: string | undefined,
  supported: readonly string[],
  fallback: string | null,
): string | null {
  const requested = value?.toLowerCase()
  if (requested && !supported.includes(requested)) {
    throw new ChatModelSelectionError(409, { error: '当前模型不支持所选思考深度' })
  }
  return requested ?? fallback
}

function assertPremiumAccess(access: ModelAccessClass, allowPremium: boolean | undefined): void {
  if (access === 'premium' && allowPremium !== true) {
    throw new ChatModelSelectionError(403, { error: '该模型需要会员' })
  }
}

function resolveDirectDeepSeekSelection(options: ResolveChatModelOptions): ChatModelSelection | null {
  if (!options.modelId) return null
  const route = getDirectDeepSeekCatalogRoute(options.modelId)
  if (!route) return null
  assertPremiumAccess(route.access, options.allowPremium)
  const effort = requestedEffort(
    options.reasoningEffort,
    route.reasoningEfforts,
    route.defaultReasoningEffort,
  )
  const capability = getModelCapability(route.runtimeModel)
  const apiKey = requiredEnvironmentKey(capability.provider.apiKeyEnv)
  return {
    customEndpoint: false,
    model: capability.id,
    thinking: effort !== 'none',
    reasoningEffort: effort,
    accessClass: route.access,
    capability,
    apiKey,
    authType: capability.provider.authType,
    outputKind: route.outputKind,
    platformTierLabel: route.name,
  }
}

async function resolveCatalogSelection(
  options: ResolveChatModelOptions,
): Promise<ChatModelSelection> {
  const direct = resolveDirectDeepSeekSelection(options)
  if (direct) return direct
  const model = await getOpenRouterModel(options.modelId ?? '')
  if (!model) {
    throw new ChatModelSelectionError(404, { error: '该模型当前未在 OpenRouter 提供' })
  }
  assertPremiumAccess(model.access, options.allowPremium)
  const apiKey = requiredEnvironmentKey('OPENROUTER_API_KEY')
  const effort = requestedEffort(
    options.reasoningEffort,
    model.reasoningEfforts,
    model.defaultReasoningEffort,
  )
  return {
    customEndpoint: false,
    model: model.id,
    thinking: Boolean(effort && effort !== 'none'),
    reasoningEffort: effort,
    accessClass: model.access,
    capability: openRouterModelCapability(model),
    apiKey,
    authType: 'bearer',
    outputKind: model.outputKind,
    platformTierLabel: model.name,
  }
}

function customEndpointFailure(error: unknown): ChatModelSelectionError {
  if (error instanceof ChatModelSelectionError) return error
  if (error instanceof ModelEndpointError) {
    return new ChatModelSelectionError(error.status, {
      error: error.message,
      stage: error.stage,
      code: error.code,
    })
  }
  return new ChatModelSelectionError(409, {
    error: error instanceof Error ? error.message : '自定义模型配置不可用',
  })
}

async function resolveCustomEndpointSelection(
  options: ResolveChatModelOptions,
  dependencies: ModelSelectionDependencies,
): Promise<ChatModelSelection> {
  if (!options.supabase || !options.userId || !options.endpointId) {
    throw new ChatModelSelectionError(401, { error: '请先登录后使用自定义模型' })
  }
  try {
    const endpoint = await dependencies.getOwnedEndpoint(
      options.supabase,
      options.userId,
      options.endpointId,
    )
    if (!endpoint) {
      throw new ChatModelSelectionError(404, { error: '自定义模型不存在或无权访问' })
    }
    if (!isModelOutputKind(endpoint.output_kind)) {
      throw new ChatModelSelectionError(409, {
        error: '自定义模型用途无效，请在设置中重新连接',
      })
    }
    const apiKey = dependencies.resolveEndpointKey(endpoint, options.userId)
    const baseUrl = await dependencies.validateEndpointNetwork(endpoint.base_url)
    return {
      customEndpoint: true,
      model: endpoint.model,
      thinking: false,
      reasoningEffort: null,
      accessClass: 'legacy',
      capability: customModelCapability(endpoint.model, baseUrl),
      apiKey,
      authType: endpointAuthType(endpoint.auth_type),
      outputKind: endpoint.output_kind,
      endpointDisplayName: typeof endpoint.name === 'string' ? endpoint.name : undefined,
    }
  } catch (error) {
    throw customEndpointFailure(error)
  }
}

function resolveMediaTier(
  tierConfig: (typeof TIER_MAP)[keyof typeof TIER_MAP],
): ChatModelSelection {
  return {
    customEndpoint: false,
    model: tierConfig.model,
    thinking: false,
    reasoningEffort: null,
    accessClass: 'legacy',
    capability: customModelCapability(
      tierConfig.model,
      process.env.DEEP_TIER_BASE_URL?.trim() || 'https://invalid.local',
    ),
    apiKey: process.env.DEEP_TIER_API_KEY?.trim() || '',
    authType: (process.env.DEEP_TIER_AUTH_TYPE as EndpointAuthType | undefined) || 'bearer',
    outputKind: tierConfig.id === '绘影' ? 'image' : 'video',
    platformTierLabel: tierConfig.label,
  }
}

function resolveLegacyTierSelection(tier: string): ChatModelSelection {
  const tierConfig = TIER_MAP[tier as keyof typeof TIER_MAP] ?? TIER_MAP['绝句']
  if (tierConfig.id === '绘影' || tierConfig.id === '录像') {
    return resolveMediaTier(tierConfig)
  }
  const modelKey = tierConfig.id === '鸿篇' ? 'platform-deep' : tierConfig.model
  const capability = getModelCapability(modelKey)
  const apiKey = requiredEnvironmentKey(capability.provider.apiKeyEnv)
  return {
    customEndpoint: false,
    model: capability.id,
    thinking: capability.supportsThinking && tierConfig.thinking,
    reasoningEffort: null,
    accessClass: 'legacy',
    capability,
    apiKey,
    authType: capability.provider.authType,
    outputKind: 'chat',
    platformTierLabel: tierConfig.label,
  }
}

export async function resolveChatModelSelection(
  options: ResolveChatModelOptions,
  dependencies: ModelSelectionDependencies = DEFAULT_DEPENDENCIES,
): Promise<ChatModelSelection> {
  if (options.modelId) return resolveCatalogSelection(options)
  if (options.endpointId) return resolveCustomEndpointSelection(options, dependencies)
  return resolveLegacyTierSelection(options.tier)
}
