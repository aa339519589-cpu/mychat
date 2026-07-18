import type { RawMsg } from '@/lib/llm/types'
import type { SearchMode } from '@/lib/search-mode'
import { isRecord } from '@/lib/unknown-value'

const INSTANT_GREETING = /^(?:(?:你|您)好(?:呀|啊|呢)?|嗨(?:呀|啊)?|哈[喽啰](?:呀|啊)?|嘿(?:呀|啊)?|在吗|早安|早上好|下午好|晚上好|晚安|hello|hi|hey|yo|test|测试|👋)[\s!！?？。.]*$/iu

function messageText(message: RawMsg): string {
  if (typeof message.content === 'string') return message.content
  if (!Array.isArray(message.content)) return ''
  return message.content
    .map(part => isRecord(part) && typeof part.text === 'string' ? part.text : '')
    .filter(Boolean)
    .join('\n')
}

function latestUserMessage(messages: RawMsg[]): RawMsg | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === 'user') return messages[index]
  }
  return null
}

function hasVisualInput(message: RawMsg): boolean {
  if (message.images?.length || message.imageSummary) return true
  if (!Array.isArray(message.content)) return false
  return message.content.some(part => {
    if (!isRecord(part)) return false
    return part.type === 'image_url' || part.type === 'input_image' || part.type === 'image'
  })
}

export function isInstantReplyCandidate(options: {
  messages: RawMsg[]
  searchMode: SearchMode
  deepResearch: boolean
  attachments?: readonly unknown[]
  inProject: boolean
}): boolean {
  if (options.searchMode !== 'off' || options.deepResearch || options.attachments?.length || options.inProject) {
    return false
  }
  const latest = latestUserMessage(options.messages)
  if (!latest || hasVisualInput(latest)) return false
  const text = messageText(latest).trim()
  return text.length <= 24 && INSTANT_GREETING.test(text)
}
