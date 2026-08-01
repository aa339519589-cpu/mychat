import { CURATED_OPENROUTER_MODELS, type ModelCatalogItem } from '@/lib/model-catalog'

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'
const CACHE_MS = 5 * 60_000

type OpenRouterModel = {
  id?: unknown
  context_length?: unknown
  architecture?: {
    input_modalities?: unknown
    output_modalities?: unknown
  }
  pricing?: {
    prompt?: unknown
    completion?: unknown
  }
  supported_parameters?: unknown
  reasoning?: {
    mandatory?: unknown
    supported_efforts?: unknown
    default_effort?: unknown
  }
}

type OpenRouterPayload = { data?: unknown }

let cache: { expiresAt: number; value: ModelCatalogItem[] } | null = null
let pending: Promise<ModelCatalogItem[]> | null = null

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function finiteNumber(value: unknown): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(number) && number >= 0 ? number : 0
}

function reasoningEfforts(model: OpenRouterModel): {
  values: string[]
  mandatory: boolean
  defaultValue: string | null
} {
  const parameters = stringList(model.supported_parameters)
  const supportsReasoning = parameters.includes('reasoning') || parameters.includes('reasoning_effort')
  if (!supportsReasoning) return { values: [], mandatory: false, defaultValue: null }
  const mandatory = model.reasoning?.mandatory === true
  const provided = stringList(model.reasoning?.supported_efforts)
    .map(value => value.toLowerCase())
    .filter((value, index, all) => value.length > 0 && all.indexOf(value) === index)
  const values = provided.length > 0 ? provided : ['high']
  if (!mandatory && !values.includes('none')) values.unshift('none')
  const requestedDefault = typeof model.reasoning?.default_effort === 'string'
    ? model.reasoning.default_effort.toLowerCase()
    : null
  const defaultValue = requestedDefault && values.includes(requestedDefault)
    ? requestedDefault
    : values.includes('none') ? 'none' : values[0] ?? null
  return { values, mandatory, defaultValue }
}

function catalogItem(model: OpenRouterModel, curated: (typeof CURATED_OPENROUTER_MODELS)[number]): ModelCatalogItem {
  const inputs = stringList(model.architecture?.input_modalities)
  const outputs = stringList(model.architecture?.output_modalities)
  const parameters = stringList(model.supported_parameters)
  const reasoning = reasoningEfforts(model)
  return {
    id: curated.id,
    name: curated.name,
    provider: curated.provider,
    access: curated.access,
    outputKind: outputs.includes('image') && !outputs.includes('text') ? 'image' : 'chat',
    promptPrice: finiteNumber(model.pricing?.prompt) * 1_000_000,
    completionPrice: finiteNumber(model.pricing?.completion) * 1_000_000,
    contextLength: Math.max(0, Math.floor(finiteNumber(model.context_length))),
    vision: inputs.includes('image'),
    tools: parameters.includes('tools') || parameters.includes('tool_choice'),
    flagship: curated.flagship,
    reasoningEfforts: reasoning.values,
    defaultReasoningEffort: reasoning.defaultValue,
    reasoningMandatory: reasoning.mandatory,
  }
}

async function retrieveCatalog(): Promise<ModelCatalogItem[]> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 12_000)
  try {
    const apiKey = process.env.OPENROUTER_API_KEY?.trim()
    const response = await fetch(OPENROUTER_MODELS_URL, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      cache: 'no-store',
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`OpenRouter catalog returned ${response.status}`)
    const payload = await response.json() as OpenRouterPayload
    if (!Array.isArray(payload.data)) throw new Error('OpenRouter catalog response is malformed')
    const live = new Map<string, OpenRouterModel>()
    for (const entry of payload.data) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
      const model = entry as OpenRouterModel
      if (typeof model.id === 'string') live.set(model.id, model)
    }
    return CURATED_OPENROUTER_MODELS.flatMap(curated => {
      const model = live.get(curated.id)
      return model ? [catalogItem(model, curated)] : []
    })
  } finally {
    clearTimeout(timeout)
  }
}

export async function getOpenRouterCatalog(options: { fresh?: boolean } = {}): Promise<ModelCatalogItem[]> {
  const now = Date.now()
  if (!options.fresh && cache && cache.expiresAt > now) return cache.value
  if (!pending) {
    pending = retrieveCatalog().then(value => {
      cache = { expiresAt: Date.now() + CACHE_MS, value }
      return value
    }).finally(() => { pending = null })
  }
  return pending
}

export async function getOpenRouterModel(modelId: string): Promise<ModelCatalogItem | null> {
  const catalog = await getOpenRouterCatalog()
  return catalog.find(model => model.id === modelId) ?? null
}
