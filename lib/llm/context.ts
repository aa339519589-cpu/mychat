import type { ModelCapability } from './models'
import type { RawMsg } from './types'

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

const NATURAL_REPLY_GUARD = '不要描述自己的状态或风格调整，不要说“我不装”“我不学术腔”“我会自然一点”这类自我说明；直接自然地回答。'

function toBeijingTime(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 8 * 3600 * 1000)
  const Y = d.getUTCFullYear()
  const M = String(d.getUTCMonth() + 1).padStart(2, '0')
  const D = String(d.getUTCDate()).padStart(2, '0')
  const h = String(d.getUTCHours()).padStart(2, '0')
  const m = String(d.getUTCMinutes()).padStart(2, '0')
  return `${Y}-${M}-${D} ${h}:${m} 北京时间`
}

function textFromRawContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part): part is { type: 'text'; text: string } => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n')
}

export function imageRefsFromMessage(message: RawMsg): string[] {
  const direct = Array.isArray(message.images) ? message.images : []
  const embedded = Array.isArray(message.content)
    ? message.content
      .filter((part: any) => part?.type === 'image_url' && typeof part.image_url?.url === 'string')
      .map((part: any) => part.image_url.url as string)
    : []
  return [...new Set([...direct, ...embedded].filter(url => typeof url === 'string' && /^(data:image\/|https?:\/\/)/.test(url)))]
}

function textWithMetadata(message: RawMsg, includeImageSummary: boolean, hasImages: boolean, isLatestUser: boolean): string {
  let text = textFromRawContent(message.content)
  if (includeImageSummary && hasImages) {
    const summary = message.imageSummary?.trim() || '图片内容暂未能识别。'
    text = `${text}\n\n用户曾上传${imageRefsFromMessage(message).length > 1 ? '多张图片' : '一张图片'}，内容摘要：${summary}`.trim()
  }
  if (message.role === 'user' && message.ts) {
    text = `${text}\n\n[发送时间：${toBeijingTime(message.ts)}]`.trim()
  }
  if (isLatestUser) {
    text = `${text}\n\n[隐藏表达要求：${NATURAL_REPLY_GUARD}]`.trim()
  }
  return text
}

export function buildModelContext(messages: RawMsg[], capability: ModelCapability) {
  let latestUserIndex = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      latestUserIndex = i
      break
    }
  }

  return messages.map((message, index) => {
    const images = imageRefsFromMessage(message)
    const canSendImages = message.role === 'user'
      && capability.supportsVision
      && capability.supportsImageInput
      && images.length > 0
    const text = textWithMetadata(message, !canSendImages, images.length > 0, index === latestUserIndex)

    if (!canSendImages) return { role: message.role, content: text }

    const content: ContentPart[] = []
    if (text) content.push({ type: 'text', text })
    content.push(...images.map(url => ({ type: 'image_url' as const, image_url: { url } })))
    return { role: message.role, content }
  })
}
