import { isRecord } from '@/lib/unknown-value'

export type TokenUsage = {
  /** Historical provider input counter; retained to avoid changing the billing contract. */
  inputTokens: number
  outputTokens: number
  /** Complete prompt size when cache categories are supplied by the provider. */
  totalInputTokens?: number
  cachedInputTokens?: number
  cacheCreationInputTokens?: number
  cacheCreation5mInputTokens?: number
  cacheCreation1hInputTokens?: number
  reasoningOutputTokens?: number
}

const DETAIL_KEYS = ['totalInputTokens', 'cachedInputTokens', 'cacheCreationInputTokens',
  'cacheCreation5mInputTokens', 'cacheCreation1hInputTokens', 'reasoningOutputTokens'] as const

type UsageDetails = Partial<Pick<TokenUsage, typeof DETAIL_KEYS[number]>>

function tokenCount(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null
}

function validDetails(value: Record<string, unknown>): UsageDetails {
  const details: UsageDetails = {}
  for (const key of DETAIL_KEYS) {
    const count = tokenCount(value[key])
    if (count !== null) details[key] = count
  }
  return details
}

export function normalizeTokenUsage(value: unknown): TokenUsage | null {
  if (!isRecord(value)) return null
  const inputTokens = tokenCount(value.inputTokens)
  const outputTokens = tokenCount(value.outputTokens)
  if (inputTokens === null || outputTokens === null) return null
  return { inputTokens, outputTokens, ...validDetails(value) }
}

/** Optional fields stay absent when not reported; absent never means zero cache hits. */
export function providerUsageDetails(value: unknown): UsageDetails {
  if (!isRecord(value)) return {}
  const prompt = isRecord(value.prompt_tokens_details) ? value.prompt_tokens_details
    : isRecord(value.input_tokens_details) ? value.input_tokens_details : {}
  const completion = isRecord(value.completion_tokens_details) ? value.completion_tokens_details
    : isRecord(value.output_tokens_details) ? value.output_tokens_details : {}
  const creation = isRecord(value.cache_creation) ? value.cache_creation : {}
  return validDetails({
    cachedInputTokens: value.cache_read_input_tokens ?? prompt.cached_tokens,
    cacheCreationInputTokens: value.cache_creation_input_tokens,
    cacheCreation5mInputTokens: creation.ephemeral_5m_input_tokens,
    cacheCreation1hInputTokens: creation.ephemeral_1h_input_tokens,
    reasoningOutputTokens: completion.reasoning_tokens,
  })
}

export function providerTokenUsage(value: unknown): TokenUsage | null {
  if (!isRecord(value)) return null
  const inputTokens = tokenCount(value.prompt_tokens) ?? tokenCount(value.input_tokens)
  const outputTokens = tokenCount(value.completion_tokens) ?? tokenCount(value.output_tokens)
  if (inputTokens === null || outputTokens === null) return null
  const details = providerUsageDetails(value)
  const anthropic = value.cache_read_input_tokens !== undefined || value.cache_creation_input_tokens !== undefined
  const completeCache = details.cachedInputTokens !== undefined && details.cacheCreationInputTokens !== undefined
  return {
    inputTokens, outputTokens, ...details,
    ...(anthropic && completeCache ? { totalInputTokens: inputTokens + details.cachedInputTokens! + details.cacheCreationInputTokens! }
      : !anthropic && details.cachedInputTokens !== undefined ? { totalInputTokens: inputTokens } : {}),
  }
}

export function addTokenUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  const details: UsageDetails = {}
  for (const key of DETAIL_KEYS) {
    // A partial aggregate would look like complete evidence. Preserve a detail
    // only when both turns reported it; per-turn logs retain partial evidence.
    if (left[key] !== undefined && right[key] !== undefined) details[key] = left[key] + right[key]
  }
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    ...details,
  }
}

export function tokenUsageTotal(value: TokenUsage): number {
  // Existing quota/billing semantics are intentionally unchanged. Cost analysis
  // must use the separated provider cache categories and actual supplier rates.
  return value.inputTokens + value.outputTokens
}
