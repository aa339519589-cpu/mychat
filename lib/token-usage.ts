import { isRecord } from '@/lib/unknown-value'

export type TokenUsage = {
  inputTokens: number
  outputTokens: number
}

function tokenCount(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null
}

export function normalizeTokenUsage(value: unknown): TokenUsage | null {
  if (!isRecord(value)) return null
  const inputTokens = tokenCount(value.inputTokens)
  const outputTokens = tokenCount(value.outputTokens)
  if (inputTokens === null || outputTokens === null) return null
  return { inputTokens, outputTokens }
}

export function providerTokenUsage(value: unknown): TokenUsage | null {
  if (!isRecord(value)) return null
  const inputTokens = tokenCount(value.prompt_tokens) ?? tokenCount(value.input_tokens)
  const outputTokens = tokenCount(value.completion_tokens) ?? tokenCount(value.output_tokens)
  if (inputTokens === null || outputTokens === null) return null
  return { inputTokens, outputTokens }
}

export function addTokenUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
  }
}

export function tokenUsageTotal(value: TokenUsage): number {
  return value.inputTokens + value.outputTokens
}
