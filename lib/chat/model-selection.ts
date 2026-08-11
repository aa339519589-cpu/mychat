import type { SupabaseServer } from '@/lib/api/guard'
import { TIER_MAP } from '@/lib/chat-data'
import type { ModelAccessClass } from '@/lib/model-catalog'
import { customModelReasoningProfile, normalizeReasoningEffort, type ReasoningEffort } from '@/lib/model-reasoning'
import { getOpenRouterModel } from '@/lib/openrouter-catalog'
import { endpointAuthType, getOwnedModelEndpoint, resolveModelEndpointKey, type ModelEndpointRow } from '@/lib/model-endpoint-server'
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
  constructor(public readonly status: number, public readonly payload: Record<string, unknown>, public readonly rawJson = false, public readonly logMessage?: string) {
    super(typeof payload.error === 'string' ? payload.error : '模型配置不可用')
    this.name = 'ChatModelSelectionError'
  }
  toResponse(): Response { return this.rawJson ? new Response(JSON.stringify(this.payload), { status: this.status }) : Response.json(this.payload, { status: this.status }) }
}

type ModelSelectionDependencies = {
  getOwnedEndpoint: (supabase: SupabaseServer, userId: string, endpointId: string) => Promise<ModelEndpointRow | null>
  resolveEndpointKey: (endpoint: ModelEndpointRow, userId: string) => string
  validateEndpointNetwork: (baseUrl: string) => Promise<string>
}
const DEFAULT_DEPENDENCIES: ModelSelectionDependencies = {
  getOwnedEndpoint: (supabase, userId, endpointId) => getOwnedModelEndpoint(supabase, userId, endpointId),
  resolveEndpointKey: resolveModelEndpointKey,
  validateEndpointNetwork: validateModelEndpointNetwork,
}

function resolveDirectDeepSeekSelection(options: {
  modelId: string
  reasoningEffort?: string
  allowPremium?: boolean
}): ChatModelSelection | null {
  const route = getDirectDeepSeekCatalogRoute(options.modelId)
  if (!route) return null
  if (route.access === 'premium' && options.allowPremium !== true) {
    throw new ChatModelSelectionError(403, { error: '该模型需要会员' })
  }
  const requested = options.reasoningEffort?.toLowerCase()
  if (requested && !route.reasoningEfforts.includes(requested)) {
    throw new ChatModelSelectionError(409, { error: '当前模型不支持所选思考深度' })
  }
  const effort = requested ?? route.defaultReasoningEffort
  const capability = getModelCapability(route.runtimeModel)
  const apiKeyEnvironment = capability.provider.apiKeyEnv
  const apiKey = apiKeyEnvironment ? process.env[apiKeyEnvironment]?.trim() ?? '' : ''
  if (!apiKey) {
    throw new ChatModelSelectionError(
      500,
      { error: `服务未配置（${apiKeyEnvironment ?? '模型 API Key'} 未设置）` },
      true,
      `${apiKeyEnvironment ?? 'model key'} not configured`,
    )
  }
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

function customReasoningEffort(model: string, requestedValue: string | undefined): ReasoningEffort | null {
  const profile = customModelReasoningProfile(model)
  const requested = requestedValue === undefined ? null : normalizeReasoningEffort(requestedValue)
  if (requestedValue !== undefined && requested === null) {
    throw new ChatModelSelectionError(409, { error: '思考深度参数无效' })
  }
  if (profile.reasoningMandatory && requested === 'none') {
    throw new ChatModelSelectionError(409, { error: '当前模型必须启用思考，不能选择 Off' })
  }
  if (requested && !profile.reasoningEfforts.includes(requested)) {
    throw new ChatModelSelectionError(409, { error: '当前自定义模型不支持所选思考深度' })
  }
  const resolved = requested ?? profile.defaultReasoningEffort
  if (profile.reasoningMandatory && !resolved) {
    throw new ChatModelSelectionError(409, { error: '当前模型必须启用思考' })
  }
  return resolved
}

export async function resolveChatModelSelection(options: {
  tier: string
  endpointId?: string
  modelId?: string
  reasoningEffort?: string
  supabase: SupabaseServer | null
  userId: string | null
  allowPremium?: boolean
}, dependencies: ModelSelectionDependencies = DEFAULT_DEPENDENCIES): Promise<ChatModelSelection> {
  if (options.modelId) {
    const directDeepSeek = resolveDirectDeepSeekSelection({
      modelId: options.modelId,
      reasoningEffort: options.reasoningEffort,
      allowPremium: options.allowPremium,
    })
    if (directDeepSeek) return directDeepSeek

    const model = await getOpenRouterModel(options.modelId)
    if (!model) throw new ChatModelSelectionError(404, { error: '该模型当前未在 OpenRouter 提供' })
    if (model.access === 'premium' && options.allowPremium !== true) throw new ChatModelSelectionError(403, { error: '该模型需要会员' })
    const apiKey = process.env.OPENROUTER_API_KEY?.trim() ?? ''
    if (!apiKey) throw new ChatModelSelectionError(500, { error: '服务未配置（OPENROUTER_API_KEY 未设置）' }, true, 'OPENROUTER_API_KEY not configured')
    const requested = options.reasoningEffort?.toLowerCase()
    const effort = requested && model.reasoningEfforts.includes(requested)
      ? requested
      : model.defaultReasoningEffort
    if (requested && !model.reasoningEfforts.includes(requested)) {
      throw new ChatModelSelectionError(409, { error: '当前模型不支持所选思考深度' })
    }
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

  const customEndpoint = typeof options.endpointId === 'string'
  if (customEndpoint) {
    if (!options.supabase || !options.userId) throw new ChatModelSelectionError(401, { error: '请先登录后使用自定义模型' })
    try {
      const endpoint = await dependencies.getOwnedEndpoint(options.supabase, options.userId, options.endpointId!)
      if (!endpoint) throw new ChatModelSelectionError(404, { error: '自定义模型不存在或无权访问' })
      if (!isModelOutputKind(endpoint.output_kind)) throw new ChatModelSelectionError(409, { error: '自定义模型用途无效，请在设置中重新连接' })
      const reasoningEffort = endpoint.output_kind === 'chat'
        ? customReasoningEffort(endpoint.model, options.reasoningEffort)
        : null
      const apiKey = dependencies.resolveEndpointKey(endpoint, options.userId)
      const baseUrl = await dependencies.validateEndpointNetwork(endpoint.base_url)
      return {
        customEndpoint: true,
        model: endpoint.model,
        thinking: Boolean(reasoningEffort && reasoningEffort !== 'none'),
        reasoningEffort,
        accessClass: 'legacy',
        capability: customModelCapability(endpoint.model, baseUrl),
        apiKey,
        authType: endpointAuthType(endpoint.auth_type),
        outputKind: endpoint.output_kind,
        endpointDisplayName: typeof endpoint.name === 'string' ? endpoint.name : undefined,
      }
    } catch (error) {
      if (error instanceof ChatModelSelectionError) throw error
      if (error instanceof ModelEndpointError) throw new ChatModelSelectionError(error.status, { error: error.message, stage: error.stage, code: error.code })
      throw new ChatModelSelectionError(409, { error: error instanceof Error ? error.message : '自定义模型配置不可用' })
    }
  }

  const tierConfig = TIER_MAP[options.tier as keyof typeof TIER_MAP] ?? TIER_MAP['绝句']
  if (tierConfig.id === '绘影' || tierConfig.id === '录像') {
    return {
      customEndpoint: false,
      model: tierConfig.model,
      thinking: false,
      reasoningEffort: null,
      accessClass: 'legacy',
      capability: customModelCapability(tierConfig.model, process.env.DEEP_TIER_BASE_URL?.trim() || 'https://invalid.local'),
      apiKey: process.env.DEEP_TIER_API_KEY?.trim() || '',
      authType: (process.env.DEEP_TIER_AUTH_TYPE as EndpointAuthType | undefined) || 'bearer',
      outputKind: tierConfig.id === '绘影' ? 'image' : 'video',
      platformTierLabel: tierConfig.label,
    }
  }
  const modelKey = tierConfig.id === '鸿篇' ? 'platform-deep' : tierConfig.model
  const capability = getModelCapability(modelKey)
  const apiKeyEnvironment = capability.provider.apiKeyEnv
  const apiKey = apiKeyEnvironment ? process.env[apiKeyEnvironment] ?? '' : ''
  if (!apiKey) throw new ChatModelSelectionError(500, { error: `服务未配置（${apiKeyEnvironment ?? '模型 API Key'} 未设置）` }, true, `${apiKeyEnvironment ?? 'model key'} not configured`)
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
