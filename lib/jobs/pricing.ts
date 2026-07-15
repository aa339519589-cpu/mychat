export const BILLING_PRICE_VERSION = 1

const PLATFORM_MODEL_MICROS_PER_WEIGHTED_TOKEN = 3

const PLATFORM_MEDIA = {
  image: { weightedTokens: 200_000, costMicros: 250_000 },
  video: { weightedTokens: 5_000_000, costMicros: 10_000_000 },
} as const

export function platformModelCostMicros(weightedTokens: number, customerFunded = false): number {
  if (customerFunded || !Number.isSafeInteger(weightedTokens) || weightedTokens <= 0) return 0
  return weightedTokens * PLATFORM_MODEL_MICROS_PER_WEIGHTED_TOKEN
}

export function platformMediaUsage(
  outputKind: 'image' | 'video',
  customerFunded = false,
): { weightedTokens: number; costMicros: number; priceVersion: number } {
  if (customerFunded) return { weightedTokens: 0, costMicros: 0, priceVersion: BILLING_PRICE_VERSION }
  return { ...PLATFORM_MEDIA[outputKind], priceVersion: BILLING_PRICE_VERSION }
}
