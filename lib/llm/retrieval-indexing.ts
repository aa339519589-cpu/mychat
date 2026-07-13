import { createHash } from "crypto"
import { log } from "@/lib/logger"
import { isRecord } from '@/lib/unknown-value'

const CHUNK_MESSAGE_COUNT = 8
const CHUNK_OVERLAP = 2
const MAX_CHUNK_CHARS = 4200

export type MessageRow = {
  id: string
  role: 'user' | 'assistant'
  content: string | null
  images?: unknown
  created_at?: string | null
  conversation_id?: string | null
}

function embeddingConfig() {
  return {
    apiKey: process.env.EMBEDDING_API_KEY || process.env.OPENAI_API_KEY || '',
    baseUrl: (process.env.EMBEDDING_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    model: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
    dimensions: process.env.EMBEDDING_DIMENSIONS ? Number(process.env.EMBEDDING_DIMENSIONS) : undefined,
  }
}

export function embeddingEnabled(): boolean {
  const cfg = embeddingConfig()
  return !!cfg.apiKey && !!cfg.model
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3)
}

export function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function imageSummaryFromStoredImages(images: unknown): string {
  if (!images || Array.isArray(images)) return ''
  const summary = isRecord(images) ? images.image_summary : undefined
  return typeof summary === 'string' ? summary.trim() : ''
}

export function normalizeMessage(m: MessageRow): string {
  const speaker = m.role === 'user' ? '用户' : '模型'
  const content = (m.content ?? '').trim()
  const imageSummary = imageSummaryFromStoredImages(m.images)
  const body = [content, imageSummary ? `图片摘要：${imageSummary}` : ''].filter(Boolean).join('\n')
  return `【${speaker}】${body || '（空）'}`
}

export function chunkMessages(messages: MessageRow[]) {
  const chunks: { start: MessageRow; end: MessageRow; content: string }[] = []
  if (!messages.length) return chunks

  for (let i = 0; i < messages.length; i += Math.max(1, CHUNK_MESSAGE_COUNT - CHUNK_OVERLAP)) {
    const part: MessageRow[] = []
    let chars = 0
    for (let j = i; j < messages.length && part.length < CHUNK_MESSAGE_COUNT; j++) {
      const text = normalizeMessage(messages[j])
      if (part.length > 0 && chars + text.length > MAX_CHUNK_CHARS) break
      part.push(messages[j])
      chars += text.length
    }
    if (part.length < 2) continue
    const content = part.map(normalizeMessage).join('\n\n').trim()
    if (!content) continue
    chunks.push({ start: part[0], end: part[part.length - 1], content })
  }

  return chunks
}

export async function embed(input: string, parentSignal?: AbortSignal): Promise<number[] | null> {
  const cfg = embeddingConfig()
  if (!cfg.apiKey) return null

  try {
    const body: Record<string, unknown> = { model: cfg.model, input }
    if (Number.isFinite(cfg.dimensions)) body.dimensions = cfg.dimensions

    const signals = [parentSignal, AbortSignal.timeout(30_000)].filter(Boolean) as AbortSignal[]
    const res = await fetch(`${cfg.baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
      signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
    })
    if (!res.ok) {
      // Do not persist arbitrary upstream response bodies: providers may echo the
      // indexed user text or include credential-bearing proxy diagnostics.
      await res.body?.cancel().catch(() => undefined)
      log.warn('activeRetrieval', 'Embedding request failed', { status: res.status })
      return null
    }
    const json = await res.json()
    const record = isRecord(json) ? json : null
    const first = Array.isArray(record?.data) && isRecord(record.data[0]) ? record.data[0] : null
    const vector = first?.embedding
    return Array.isArray(vector) ? vector : null
  } catch (e) {
    if (parentSignal?.aborted) throw e
    log.warn('activeRetrieval', 'Embedding skipped', e)
    return null
  }
}
