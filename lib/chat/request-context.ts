import type { RawMsg } from '@/lib/llm/types'
import { isRecord } from '@/lib/unknown-value'
import type { HistoryRetrievalMode } from '@/lib/llm/active-retrieval'
export { latestBeijingDateFromMessages } from '@/lib/search-mode'
export type { SearchMode } from '@/lib/search-mode'
export { appendUserSystemPrompt } from '@/lib/user-system-prompt'

export function resolveReasoningEffort(options: {
  isDeepTierProxy: boolean
  modelId: string
  configuredEffort?: string
}): 'low' | 'medium' | 'high' | null {
  if (!options.isDeepTierProxy && !/^grok/i.test(options.modelId)) return null

  const configured = (options.configuredEffort ?? process.env.DEEP_TIER_REASONING_EFFORT ?? 'low')
    .trim()
    .toLowerCase()
  if (configured === 'medium' || configured === 'high') return configured
  // Grok 4.5 cannot fully disable reasoning, so both "none" and invalid values
  // intentionally fall back to the lowest supported effort.
  return 'low'
}

export function historyRetrievalModeForTier(tier: string): HistoryRetrievalMode {
  if (tier === '鸿篇') return 'deep'
  if (tier === '绝句' || tier === '绘影' || tier === '录像') return 'light'
  return 'balanced'
}

function messageText(message: RawMsg): string {
  if (typeof message.content === 'string') return message.content
  if (!Array.isArray(message.content)) return ''
  return message.content
    .map(part => isRecord(part) && typeof part.text === 'string' ? part.text : '')
    .filter(Boolean)
    .join('\n')
}

export function latestUserPrompt(messages: RawMsg[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== 'user') continue
    const text = messageText(message).trim()
    if (text) return text.slice(0, 32_000)
  }
  return ''
}

/** Return safe reference images from the latest user turn only. */
export function latestUserSourceImages(messages: RawMsg[]): string[] {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== 'user') continue
    const images: string[] = []

    for (const image of message.images ?? []) {
      if (typeof image !== 'string') continue
      const value = image.trim()
      if (value.startsWith('data:image/') || /^https:\/\//i.test(value)) images.push(value)
    }
    if (Array.isArray(message.content)) {
      for (const value of message.content) {
        if (!isRecord(value)) continue
        const image = isRecord(value.image_url) ? value.image_url : null
        const url = typeof image?.url === 'string' ? image.url.trim() : ''
        if (value.type === 'image_url' && (url.startsWith('data:image/') || /^https:\/\//i.test(url))) {
          images.push(url)
        }
      }
    }
    return images.slice(0, 4)
  }
  return []
}
