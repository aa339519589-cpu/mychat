import {
  MAX_GENERATED_MEDIA_ITEMS,
  isSafeGeneratedMediaUrl,
  normalizeGeneratedMedia,
  type GeneratedMedia,
} from '@/lib/generated-media'

export type GenerationStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
export type GenerationDurability = 'durable' | 'ephemeral'
export type TerminalGenerationStatus = Extract<GenerationStatus, 'completed' | 'failed' | 'cancelled'>

export const TERMINAL_GENERATION_STATUSES: ReadonlySet<TerminalGenerationStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
])

export function isTerminalGenerationStatus(status: unknown): status is TerminalGenerationStatus {
  return typeof status === 'string'
    && TERMINAL_GENERATION_STATUSES.has(status as TerminalGenerationStatus)
}

/**
 * Canonical terminal state returned by the database compare-and-set operation.
 * Direct chat streams send this complete snapshot before their DONE sentinel so
 * clients never have to infer the winner from locally buffered deltas.
 */
export type GenerationTerminalSnapshot = {
  status: TerminalGenerationStatus
  content: string
  thinking: string
  sequence: number
  error: string | null
  media: GeneratedMedia[]
}

export type GenerationTerminalEvent = {
  terminal: GenerationTerminalSnapshot
}

/** Strictly parse the bounded media array carried by database authority. */
export function normalizeGenerationMedia(value: unknown): GeneratedMedia[] | null {
  if (!Array.isArray(value) || value.length > MAX_GENERATED_MEDIA_ITEMS) return null
  const seen = new Set<string>()
  const media: GeneratedMedia[] = []
  for (const item of value) {
    const normalized = normalizeGeneratedMedia(item)
    if (!normalized) return null
    const mimeType = normalized.mimeType?.toLowerCase()
    const validMimeType = normalized.type === 'image'
      ? /^image\/(?:png|jpeg|jpg|webp|gif)$/.test(mimeType ?? '')
      : /^video\/(?:mp4|webm|quicktime)$/.test(mimeType ?? '')
    if (!/^https:\/\//i.test(normalized.url)
      || !isSafeGeneratedMediaUrl(normalized.type, normalized.url)
      || !validMimeType) return null
    const identity = `${normalized.type}:${normalized.url}`
    if (seen.has(identity)) return null
    seen.add(identity)
    media.push(normalized)
  }
  return media
}

export function isGenerationTerminalSnapshot(value: unknown): value is GenerationTerminalSnapshot {
  if (!value || typeof value !== 'object') return false
  const snapshot = value as Record<string, unknown>
  return isTerminalGenerationStatus(snapshot.status)
    && typeof snapshot.content === 'string'
    && typeof snapshot.thinking === 'string'
    && Number.isSafeInteger(snapshot.sequence)
    && Number(snapshot.sequence) >= 0
    && (snapshot.error === null || typeof snapshot.error === 'string')
    && normalizeGenerationMedia(snapshot.media) !== null
}

export type GenerationDatabaseRow = {
  id: string
  user_id: string
  conversation_id: string
  assistant_message_id: string
  status: GenerationStatus
  content: string | null
  thinking: string | null
  sequence: number | null
  error: string | null
  media: GeneratedMedia[] | null
  cancel_requested_at?: string | null
  lease_owner?: string | null
  lease_expires_at?: string | null
  lease_version?: number | null
  created_at?: string
  updated_at?: string
}

export type GenerationLease = {
  runnerId: string
  version: number
  expiresAt: string
}

export type GenerationLeaseClaimReason =
  | 'active'
  | 'assistant_conflict'
  | 'conversation_active'
  | 'terminal'
  | 'stale'
  | 'identity_mismatch'
  | 'invalid_parent'
  | 'not_found'

export type GenerationLeaseClaimResult =
  | { ok: false; errorCode?: string }
  | {
      ok: true
      acquired: false
      status: GenerationStatus | null
      reason: GenerationLeaseClaimReason
      media: GeneratedMedia[]
    }
  | {
      ok: true
      acquired: true
      status: 'running'
      lease: GenerationLease
      media: GeneratedMedia[]
    }

export type GenerationLeaseMutationResult =
  | { ok: false; errorCode?: string }
  | {
      ok: true
      accepted: boolean
      status: GenerationStatus | null
      error?: string
      content?: string
      thinking?: string
      sequence?: number
      media: GeneratedMedia[]
    }

export type GenerationEvent = {
  generationId: string
  conversationId: string
  assistantMessageId: string
  sequence: number
  type: 'text' | 'thinking' | 'status' | 'error' | 'done'
  delta?: string
  status: GenerationStatus
  content?: string
  thinking?: string
  error?: string
  media?: GeneratedMedia[]
}

export type GenerationRecord = {
  id: string
  userId: string
  conversationId: string
  assistantMessageId: string
  status: GenerationStatus
  content: string
  thinking: string
  media: GeneratedMedia[]
  sequence: number
  error?: string
  /**
   * Durable jobs must be resumed from database authority. Memory fallback is
   * permitted only when a caller explicitly created an ephemeral job.
   */
  durability: GenerationDurability
  createdAt: number
  updatedAt: number
}
