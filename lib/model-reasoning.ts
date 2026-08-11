export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type CustomModelTransport = 'openai' | 'anthropic'
export type CustomReasoningMode = 'none' | 'adaptive' | 'budget'

export type CustomModelReasoningProfile = {
  id: 'generic' | 'claude' | 'claude-sonnet-5' | 'claude-fable-5' | 'claude-haiku-4-5'
  transport: CustomModelTransport
  reasoningMode: CustomReasoningMode
  reasoningEfforts: readonly ReasoningEffort[]
  reasoningMandatory: boolean
  defaultReasoningEffort: ReasoningEffort | null
}

const SONNET_5_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const FABLE_5_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const HAIKU_45_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const REASONING_EFFORTS = new Set<ReasoningEffort>([
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
])

const GENERIC_PROFILE: CustomModelReasoningProfile = {
  id: 'generic',
  transport: 'openai',
  reasoningMode: 'none',
  reasoningEfforts: [],
  reasoningMandatory: false,
  defaultReasoningEffort: null,
}

const CLAUDE_PROFILE: CustomModelReasoningProfile = {
  id: 'claude',
  transport: 'anthropic',
  reasoningMode: 'none',
  reasoningEfforts: [],
  reasoningMandatory: false,
  defaultReasoningEffort: null,
}

const SONNET_5_PROFILE: CustomModelReasoningProfile = {
  id: 'claude-sonnet-5',
  transport: 'anthropic',
  reasoningMode: 'adaptive',
  reasoningEfforts: SONNET_5_EFFORTS,
  reasoningMandatory: false,
  defaultReasoningEffort: 'high',
}

const FABLE_5_PROFILE: CustomModelReasoningProfile = {
  id: 'claude-fable-5',
  transport: 'anthropic',
  reasoningMode: 'adaptive',
  reasoningEfforts: FABLE_5_EFFORTS,
  reasoningMandatory: true,
  defaultReasoningEffort: 'high',
}

const HAIKU_45_PROFILE: CustomModelReasoningProfile = {
  id: 'claude-haiku-4-5',
  transport: 'anthropic',
  reasoningMode: 'budget',
  reasoningEfforts: HAIKU_45_EFFORTS,
  reasoningMandatory: false,
  defaultReasoningEffort: 'none',
}

function normalizedModelId(modelId: string): string {
  return modelId
    .trim()
    .toLowerCase()
    .replace(/[_./:]+/g, '-')
    .replace(/-+/g, '-')
}

function containsModelToken(value: string, token: string): boolean {
  return value === token || value.startsWith(`${token}-`) || value.endsWith(`-${token}`) || value.includes(`-${token}-`)
}

export function customModelReasoningProfile(modelId: string): CustomModelReasoningProfile {
  const normalized = normalizedModelId(modelId)
  if (containsModelToken(normalized, 'claude-sonnet-5')) return SONNET_5_PROFILE
  if (containsModelToken(normalized, 'claude-fable-5')) return FABLE_5_PROFILE
  if (containsModelToken(normalized, 'claude-haiku-4-5') || containsModelToken(normalized, 'claude-4-5-haiku')) {
    return HAIKU_45_PROFILE
  }
  if (containsModelToken(normalized, 'claude') || normalized.startsWith('claude-')) return CLAUDE_PROFILE
  return GENERIC_PROFILE
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && REASONING_EFFORTS.has(value.toLowerCase() as ReasoningEffort)
}

export function normalizeReasoningEffort(value: unknown): ReasoningEffort | null {
  if (!isReasoningEffort(value)) return null
  return value.toLowerCase() as ReasoningEffort
}

const HAIKU_BUDGET_TOKENS: Partial<Record<ReasoningEffort, number>> = {
  low: 1_024,
  medium: 4_096,
  high: 8_192,
  xhigh: 16_384,
  max: 32_768,
}

export function reasoningBudgetTokens(
  profile: CustomModelReasoningProfile,
  effort: ReasoningEffort,
  maxTokens: number,
): number | null {
  if (profile.reasoningMode !== 'budget' || effort === 'none') return null
  const configured = HAIKU_BUDGET_TOKENS[effort]
  if (!configured) return null
  const safeMaximum = Math.floor(maxTokens) - 1
  if (safeMaximum < 1_024) return null
  return Math.min(configured, safeMaximum)
}
