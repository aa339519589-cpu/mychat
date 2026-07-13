import type { SupabaseServer } from '@/lib/api/guard'
import { TIER_MAP } from '@/lib/chat-data'
import {
  endpointAuthType,
  getOwnedModelEndpoint,
  resolveModelEndpointKey,
  type ModelEndpointRow,
} from '@/lib/model-endpoint-server'
import { isModelOutputKind, type EndpointAuthType, type ModelOutputKind } from '@/lib/model-endpoints'
import {
  customModelCapability,
  getModelCapability,
  type ModelCapability,
} from '@/lib/llm/models'
import { ModelEndpointError, validateModelEndpointNetwork } from '@/lib/llm/openai-compatible'

export type ChatModelSelection = {
  customEndpoint: boolean
  model: string
  thinking: boolean
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
    if (this.rawJson) return new Response(JSON.stringify(this.payload), { status: this.status })
    return Response.json(this.payload, { status: this.status })
  }
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
  getOwnedEndpoint: (supabase, userId, endpointId) =>
    getOwnedModelEndpoint(supabase, userId, endpointId),
  resolveEndpointKey: resolveModelEndpointKey,
  validateEndpointNetwork: validateModelEndpointNetwork,
}

export async function resolveChatModelSelection(options: {
  tier: string
  deepResearch: boolean
  endpointId?: string
  supabase: SupabaseServer | null
  userId: string | null
}, dependencies: ModelSelectionDependencies = DEFAULT_DEPENDENCIES): Promise<ChatModelSelection> {
  const customEndpoint = typeof options.endpointId === 'string'
  if (customEndpoint) {
    if (!options.supabase || !options.userId) {
      throw new ChatModelSelectionError(401, { error: '请先登录后使用自定义模型' })
    }
    try {
      const endpoint = await dependencies.getOwnedEndpoint(
        options.supabase,
        options.userId,
        options.endpointId!,
      )
      if (!endpoint) {
        throw new ChatModelSelectionError(404, { error: '自定义模型不存在或无权访问' })
      }
      if (!isModelOutputKind(endpoint.output_kind)) {
        throw new ChatModelSelectionError(409, { error: '自定义模型用途无效，请在设置中重新连接' })
      }
      const apiKey = dependencies.resolveEndpointKey(endpoint, options.userId)
      const baseUrl = await dependencies.validateEndpointNetwork(endpoint.base_url)
      return {
        customEndpoint: true,
        model: endpoint.model,
        thinking: false,
        capability: customModelCapability(endpoint.model, baseUrl),
        apiKey,
        authType: endpointAuthType(endpoint.auth_type),
        outputKind: endpoint.output_kind,
        endpointDisplayName: typeof endpoint.name === 'string' ? endpoint.name : undefined,
      }
    } catch (error) {
      if (error instanceof ChatModelSelectionError) throw error
      if (error instanceof ModelEndpointError) {
        throw new ChatModelSelectionError(error.status, {
          error: error.message,
          stage: error.stage,
          code: error.code,
        })
      }
      throw new ChatModelSelectionError(409, {
        error: error instanceof Error ? error.message : '自定义模型配置不可用',
      })
    }
  }

  const tierConfig = TIER_MAP[options.tier as keyof typeof TIER_MAP] ?? TIER_MAP['绝句']
  if (tierConfig.id === '绘影' || tierConfig.id === '录像') {
    return {
      customEndpoint: false,
      model: tierConfig.model,
      thinking: false,
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

  const modelKey = options.deepResearch || tierConfig.id === '鸿篇'
    ? 'platform-deep'
    : tierConfig.model
  const capability = getModelCapability(modelKey)
  const apiKeyEnvironment = capability.provider.apiKeyEnv
  const apiKey = apiKeyEnvironment ? process.env[apiKeyEnvironment] ?? '' : ''
  if (!apiKey) {
    const keyLabel = apiKeyEnvironment ?? '模型 API Key'
    throw new ChatModelSelectionError(
      500,
      { error: `服务未配置（${keyLabel} 未设置）` },
      true,
      `${apiKeyEnvironment ?? 'model key'} not configured`,
    )
  }
  return {
    customEndpoint: false,
    model: capability.id,
    thinking: capability.supportsThinking && (options.deepResearch || tierConfig.thinking),
    capability,
    apiKey,
    authType: capability.provider.authType,
    outputKind: 'chat',
    platformTierLabel: tierConfig.label,
  }
}

