import {
  isTerminalGenerationStatus,
  normalizeGenerationMedia,
  type GenerationLeaseMutationResult,
  type GenerationTerminalEvent,
  type GenerationTerminalSnapshot,
} from './types'
import type { GeneratedMedia } from '@/lib/generated-media'

export type TerminalPlan = {
  status: 'completed' | 'failed' | 'cancelled'
  error?: string
  media?: GeneratedMedia[]
}

export type TerminalConfirmation =
  | { confirmed: false }
  | ({ confirmed: true } & GenerationTerminalSnapshot)

/** Convert a confirmed runner result to the shared SSE terminal contract. */
export function terminalEventFromConfirmation(
  confirmation: TerminalConfirmation,
): GenerationTerminalEvent | null {
  if (!confirmation.confirmed) return null
  return {
    terminal: {
      status: confirmation.status,
      content: confirmation.content,
      thinking: confirmation.thinking,
      sequence: confirmation.sequence,
      error: confirmation.error,
      media: confirmation.media,
    },
  }
}

export function terminalSnapshotFromMutation(
  mutation: GenerationLeaseMutationResult,
): GenerationTerminalSnapshot | null {
  const media = mutation.ok ? normalizeGenerationMedia(mutation.media) : null
  if (!mutation.ok
    || !isTerminalGenerationStatus(mutation.status)
    || typeof mutation.content !== 'string'
    || typeof mutation.thinking !== 'string'
    || !Number.isSafeInteger(mutation.sequence)
    || Number(mutation.sequence) < 0
    || !media
    || (mutation.status !== 'completed' && media.length > 0)) return null
  return {
    status: mutation.status,
    content: mutation.content,
    thinking: mutation.thinking,
    sequence: Number(mutation.sequence),
    error: mutation.error ?? null,
    media,
  }
}
