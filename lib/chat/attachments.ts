import type { Attachment } from '@/lib/llm/types'
import { log } from '@/lib/logger'
import { ocrPageImages } from '@/lib/mimo'

export function hasScannedPdfAttachment(attachments?: Attachment[]): boolean {
  return !!attachments?.some(attachment =>
    Array.isArray(attachment.pageImages) && attachment.pageImages.length > 0,
  )
}

export async function ocrScannedPdfs(
  attachments?: Attachment[],
  signal?: AbortSignal,
): Promise<Attachment[]> {
  if (!attachments?.length) return attachments ?? []
  return Promise.all(attachments.map(async attachment => {
    if (!attachment.pageImages?.length) return attachment
    const text = await ocrPageImages(attachment.pageImages, signal)
    log.info('ocrPdf', 'Scanned PDF OCR done', {
      name: attachment.name,
      pages: attachment.pageImages.length,
      textLen: text.length,
    })
    return {
      ...attachment,
      text: text || '（扫描件识别失败，请重试或换一份更清晰的文件）',
      pageImages: undefined,
    }
  }))
}

