import type { ModelCatalogItem } from '@/lib/model-catalog'
import { resolveSharedClaudeProviderConfig, sharedClaudeCatalogRoutes, sharedClaudeRuntimeModel } from '@/lib/llm/models'
import { endpointAuthHeaders } from '@/lib/llm/openai-compatible/policy'
import { isRecord } from '@/lib/unknown-value'

let cache: { expiresAt: number; models: ModelCatalogItem[] } | null = null
let pending: Promise<ModelCatalogItem[]> | null = null

function numeric(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : 0
}

async function retrieveSharedClaudeCatalog(): Promise<ModelCatalogItem[]> {
  const config = resolveSharedClaudeProviderConfig()
  if (!config) return []
  const response = await fetch(config.baseUrl.replace(/\/messages$/i, '/models'), {
    headers: { Accept: 'application/json', ...endpointAuthHeaders(config.apiKey, config.authType) },
    cache: 'no-store', signal: AbortSignal.timeout(12_000),
  })
  if (!response.ok) throw new Error(`共享 Claude 模型目录暂时不可用（${response.status}）`)
  const payload: unknown = await response.json()
  if (!isRecord(payload) || !Array.isArray(payload.data)) throw new Error('共享 Claude 模型目录格式无效')
  const live = new Map(payload.data.filter(isRecord).map(model => [model.id, model]))
  return sharedClaudeCatalogRoutes().flatMap(route => {
    const model = live.get(sharedClaudeRuntimeModel(route))
    if (!model) return []
    const pricing = isRecord(model.pricing) ? model.pricing : {}
    const architecture = isRecord(model.architecture) ? model.architecture : {}
    const inputs = Array.isArray(architecture.input_modalities) ? architecture.input_modalities : []
    const parameters = Array.isArray(model.supported_parameters) ? model.supported_parameters : []
    return [{
      id: route.catalogId, name: route.name, provider: 'Anthropic', access: route.access,
      outputKind: 'chat', promptPrice: numeric(pricing.prompt) * 1_000_000,
      completionPrice: numeric(pricing.completion) * 1_000_000,
      contextLength: numeric(model.context_length), vision: inputs.includes('image'),
      tools: parameters.includes('tools'), flagship: true,
      reasoningEfforts: [...route.reasoningEfforts], defaultReasoningEffort: route.defaultReasoningEffort,
      reasoningMandatory: route.reasoningMandatory,
    } satisfies ModelCatalogItem]
  })
}

export async function getSharedClaudeCatalog(): Promise<ModelCatalogItem[]> {
  if (!resolveSharedClaudeProviderConfig()) return []
  if (cache && cache.expiresAt > Date.now()) return cache.models
  if (!pending) {
    pending = retrieveSharedClaudeCatalog().then(models => {
      cache = { expiresAt: Date.now() + 5 * 60_000, models }
      return models
    }).finally(() => { pending = null })
  }
  return pending
}
