export type ModelAccessClass = 'quota' | 'trial' | 'premium'
export type CatalogOutputKind = 'chat' | 'image'

export type ModelCatalogItem = {
  id: string
  name: string
  provider: string
  access: ModelAccessClass
  outputKind: CatalogOutputKind
  promptPrice: number
  completionPrice: number
  contextLength: number
  vision: boolean
  tools: boolean
  flagship: boolean
  reasoningEfforts: string[]
  defaultReasoningEffort: string | null
  reasoningMandatory: boolean
  ownerUnlocked?: boolean
  trialSelectable?: boolean
  trialUnlimited?: boolean
  trialLimit?: number
  trialRemaining?: number
}

type CuratedModel = Pick<ModelCatalogItem, 'id' | 'name' | 'provider' | 'access' | 'flagship'>

/**
 * UI order is product-owned. Runtime catalog resolution keeps only exact IDs
 * returned by OpenRouter, so unavailable or renamed models never become fake
 * frontend entries or backend routes.
 */
export const CURATED_OPENROUTER_MODELS: readonly CuratedModel[] = [
  { id: 'openai/gpt-5.6-luna-pro', name: 'GPT-5.6 Luna Pro', provider: 'OpenAI', access: 'quota', flagship: true },
  { id: 'deepseek/deepseek-v4-flash-0731', name: 'DeepSeek V4 Flash', provider: 'DeepSeek', access: 'quota', flagship: false },
  { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro', provider: 'DeepSeek', access: 'quota', flagship: true },
  { id: 'openai/gpt-5.6-luna', name: 'GPT-5.6 Luna', provider: 'OpenAI', access: 'quota', flagship: false },
  { id: 'openai/gpt-5.6-sol', name: 'GPT-5.6 Sol', provider: 'OpenAI', access: 'premium', flagship: true },
  { id: 'openai/gpt-5.6-sol-pro', name: 'GPT-5.6 Sol Pro', provider: 'OpenAI', access: 'premium', flagship: true },
  { id: 'openai/gpt-5.6-terra', name: 'GPT-5.6 Terra', provider: 'OpenAI', access: 'trial', flagship: false },
  { id: 'openai/gpt-5.5', name: 'GPT-5.5', provider: 'OpenAI', access: 'premium', flagship: true },
  { id: 'openai/gpt-5.5-instant', name: 'GPT-5.5 Instant', provider: 'OpenAI', access: 'trial', flagship: false },
  { id: 'openai/gpt-5.4', name: 'GPT-5.4', provider: 'OpenAI', access: 'trial', flagship: false },
  { id: 'openai/gpt-5.2', name: 'GPT-5.2', provider: 'OpenAI', access: 'trial', flagship: false },
  { id: 'openai/gpt-5.4-pro', name: 'GPT-5.4 Pro', provider: 'OpenAI', access: 'premium', flagship: true },
  { id: 'openai/gpt-5.4-mini', name: 'GPT-5.4 Mini', provider: 'OpenAI', access: 'trial', flagship: false },
  { id: 'openai/gpt-image-2', name: 'GPT Image 2', provider: 'OpenAI', access: 'premium', flagship: true },
  { id: 'anthropic/claude-fable-5', name: 'Claude Fable 5', provider: 'Anthropic', access: 'premium', flagship: true },
  { id: 'anthropic/claude-opus-5', name: 'Claude Opus 5', provider: 'Anthropic', access: 'premium', flagship: true },
  { id: 'anthropic/claude-opus-4.8', name: 'Claude Opus 4.8', provider: 'Anthropic', access: 'premium', flagship: true },
  { id: 'anthropic/claude-opus-4.6', name: 'Claude Opus 4.6', provider: 'Anthropic', access: 'premium', flagship: true },
  { id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5', provider: 'Anthropic', access: 'premium', flagship: true },
  { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6', provider: 'Anthropic', access: 'trial', flagship: false },
  { id: 'anthropic/claude-haiku-4.5', name: 'Claude Haiku 4.5', provider: 'Anthropic', access: 'trial', flagship: false },
  { id: 'google/gemini-3.1-pro', name: 'Gemini 3.1 Pro', provider: 'Google', access: 'premium', flagship: true },
  { id: 'google/gemini-3.6-flash', name: 'Gemini 3.6 Flash', provider: 'Google', access: 'trial', flagship: false },
  { id: 'google/gemini-3.6-flash-lite', name: 'Gemini 3.6 Flash Lite', provider: 'Google', access: 'trial', flagship: false },
  { id: 'google/gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash Lite', provider: 'Google', access: 'trial', flagship: false },
  { id: 'x-ai/grok-4.5', name: 'Grok 4.5', provider: 'xAI', access: 'premium', flagship: true },
  { id: 'minimax/minimax-m3', name: 'MiniMax M3', provider: 'MiniMax', access: 'premium', flagship: true },
  { id: 'minimax/minimax-m2.7', name: 'MiniMax M2.7', provider: 'MiniMax', access: 'trial', flagship: false },
  { id: 'moonshotai/kimi-k3', name: 'Kimi K3', provider: 'Moonshot', access: 'premium', flagship: true },
  { id: 'moonshotai/kimi-k2.6', name: 'Kimi K2.6', provider: 'Moonshot', access: 'trial', flagship: false },
  { id: 'moonshotai/kimi-k2.5', name: 'Kimi K2.5', provider: 'Moonshot', access: 'trial', flagship: false },
  { id: 'z-ai/glm-5.2', name: 'GLM-5.2', provider: 'Z.ai', access: 'premium', flagship: true },
  { id: 'z-ai/glm-5.1', name: 'GLM-5.1', provider: 'Z.ai', access: 'trial', flagship: false },
] as const

export const QUOTA_MODEL_IDS = new Set(
  CURATED_OPENROUTER_MODELS.filter(model => model.access === 'quota').map(model => model.id),
)

export const TRIAL_MODEL_IDS = new Set(
  CURATED_OPENROUTER_MODELS.filter(model => model.access === 'trial').map(model => model.id),
)

export function isModelCatalogItem(value: unknown): value is ModelCatalogItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return typeof item.id === 'string'
    && typeof item.name === 'string'
    && typeof item.provider === 'string'
    && (item.access === 'quota' || item.access === 'trial' || item.access === 'premium')
    && (item.outputKind === 'chat' || item.outputKind === 'image')
    && typeof item.promptPrice === 'number'
    && typeof item.completionPrice === 'number'
    && typeof item.contextLength === 'number'
    && typeof item.vision === 'boolean'
    && typeof item.tools === 'boolean'
    && typeof item.flagship === 'boolean'
    && Array.isArray(item.reasoningEfforts)
    && item.reasoningEfforts.every(value => typeof value === 'string')
    && (item.defaultReasoningEffort === null || typeof item.defaultReasoningEffort === 'string')
    && typeof item.reasoningMandatory === 'boolean'
    && (item.ownerUnlocked === undefined || typeof item.ownerUnlocked === 'boolean')
    && (item.trialSelectable === undefined || typeof item.trialSelectable === 'boolean')
    && (item.trialUnlimited === undefined || typeof item.trialUnlimited === 'boolean')
    && (item.trialLimit === undefined || (typeof item.trialLimit === 'number' && Number.isInteger(item.trialLimit) && item.trialLimit >= 0))
    && (item.trialRemaining === undefined || (typeof item.trialRemaining === 'number' && Number.isInteger(item.trialRemaining) && item.trialRemaining >= 0))
}
