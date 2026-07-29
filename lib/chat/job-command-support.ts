import type { Attachment } from '@/lib/llm/types'
import type { JsonObject } from '@/lib/jobs/contracts'
import { isRecord } from '@/lib/unknown-value'

export function sanitizedAttachments(attachments: Attachment[] | undefined): JsonObject[] | undefined {
  if (!attachments?.length) return undefined
  return attachments.map(attachment => ({
    name: attachment.name,
    dataUrl: typeof attachment.dataUrl === 'string' ? attachment.dataUrl : '',
    isPdf: attachment.isPdf === true,
    ...(typeof attachment.text === 'string' ? { text: attachment.text } : {}),
    ...(Array.isArray(attachment.pageImages) ? { pageImages: attachment.pageImages } : {}),
  }))
}

export function referencesPayload(value: unknown, objectKey: string): boolean | null {
  if (value === null) return false
  if (!isRecord(value) || !isRecord(value.payload)) return null
  const reference = value.payload.payloadRef
  if (reference === objectKey) return true
  if (isRecord(reference) && reference.objectKey === objectKey) return true
  return false
}

export function rpcObject(value: unknown): Record<string, unknown> | null {
  const normalized = Array.isArray(value) ? value[0] : value
  return isRecord(normalized) ? normalized : null
}
