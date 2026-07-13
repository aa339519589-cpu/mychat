import type { RawMsg } from '@/lib/llm/types'
import type { HistoryRetrievalMode } from '@/lib/llm/active-retrieval'

export const DEEP_RESEARCH_PREFIX = `请以最高努力完成当前问题：先理解真实目标，拆解约束，检查边界和反例，最后给出清晰结论。\n---\n`

export function resolveReasoningEffort(options: {
  isDeepTierProxy: boolean
  deepResearch: boolean
  modelId: string
  configuredEffort?: string
}): 'low' | 'medium' | 'high' | null {
  if (!options.isDeepTierProxy && !/^grok/i.test(options.modelId)) return null
  if (options.deepResearch) return 'high'

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
    .map((part: any) => typeof part?.text === 'string' ? part.text : '')
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
      for (const part of message.content as any[]) {
        const url = typeof part?.image_url?.url === 'string' ? part.image_url.url.trim() : ''
        if (part?.type === 'image_url' && (url.startsWith('data:image/') || /^https:\/\//i.test(url))) {
          images.push(url)
        }
      }
    }
    return images.slice(0, 4)
  }
  return []
}

export function prependDeepResearchInstruction(messages: any[]): void {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== 'user') continue
    if (typeof message.content === 'string') {
      message.content = DEEP_RESEARCH_PREFIX + message.content
    } else if (Array.isArray(message.content)) {
      const textPart = message.content.find((part: any) => part.type === 'text')
      if (textPart) textPart.text = DEEP_RESEARCH_PREFIX + textPart.text
    }
    return
  }
}

