import type { RawMsg } from '@/lib/llm/types'
import { imageRefsFromMessage } from '@/lib/llm/context'
import { isRecord } from '@/lib/unknown-value'
import { AuthoritativeContextError, jsonBytes } from './authoritative-context-memory'

const MAX_CONTEXT_IMAGE_CHARS = 32_000_000
const MAX_SINGLE_IMAGE_CHARS = 8_000_000

function imageDescriptor(url: string): string {
  return url.startsWith('data:image/') ? `${url.slice(0, url.indexOf(','))},[image payload: ${url.length} chars]` : url
}

/** Binary image transport is not language context and must not spend the
 * 128 KiB text-history budget. Keep the original image for the vision model. */
export function contextBudgetMessage(message: RawMsg): RawMsg {
  const content = Array.isArray(message.content) ? message.content.map(part => {
    if (!isRecord(part) || part.type !== 'image_url' || !isRecord(part.image_url)
      || typeof part.image_url.url !== 'string') return part
    return { ...part, image_url: { ...part.image_url, url: imageDescriptor(part.image_url.url) } }
  }) : message.content
  return { ...message, content,
    ...(message.images ? { images: message.images.map(imageDescriptor) } : {}) }
}

export function contextMessageBytes(message: RawMsg): number {
  return jsonBytes(contextBudgetMessage(message))
}

export function contextMediaChars(messages: RawMsg[]): number {
  let total = 0
  for (const message of messages) {
    const images = imageRefsFromMessage(message)
    if (images.length > 8) throw new AuthoritativeContextError('CONTEXT_TOO_LARGE', '消息图片数量超过上限')
    for (const image of images) {
      if (image.length > MAX_SINGLE_IMAGE_CHARS) throw new AuthoritativeContextError('CONTEXT_TOO_LARGE', '消息图片超过处理上限')
      total += image.length
    }
  }
  if (total > MAX_CONTEXT_IMAGE_CHARS) throw new AuthoritativeContextError('CONTEXT_TOO_LARGE', '图片上下文超过处理上限')
  return total
}

export function contextBudgetValue(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.messages)) return value
  const messages = value.messages as RawMsg[]
  contextMediaChars(messages)
  return { ...value, messages: messages.map(contextBudgetMessage) }
}
