import type { Emit } from './events'
import type { RawMsg } from './types'
import { imageRefsFromMessage } from './context'
import { summarizeImages } from '@/lib/mimo'
import { log } from '@/lib/logger'

type SummaryOptions = {
  supabase: any
  userId: string | null
  emit: Emit
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function persistSummary(message: RawMsg, refs: string[], summary: string, options: SummaryOptions) {
  if (!options.supabase || !options.userId || !message.id || !UUID_RE.test(message.id)) return
  const { error } = await options.supabase
    .from('messages')
    .update({ images: { refs, image_summary: summary } })
    .eq('id', message.id)
    .eq('user_id', options.userId)
  if (error) log.warn('imageSummary', 'Failed to persist image summary', { messageId: message.id, error })
}

export async function ensureImageSummaries(messages: RawMsg[], options: SummaryOptions): Promise<RawMsg[]> {
  const prepared = messages.map(message => ({ ...message }))
  const pending = prepared.filter(message => imageRefsFromMessage(message).length > 0 && !message.imageSummary?.trim())
  if (!pending.length) return prepared

  options.emit({ thinking: '正在理解图片内容……' })
  for (const message of pending) {
    const refs = imageRefsFromMessage(message)
    const summary = await summarizeImages(refs)
    if (!summary) continue
    message.imageSummary = summary
    if (message.id) options.emit({ imageSummary: { messageId: message.id, summary } })
    await persistSummary(message, refs, summary, options)
  }
  return prepared
}
