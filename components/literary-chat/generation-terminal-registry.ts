import type { GenerationTerminalSnapshot } from '@/lib/generation/types'

const ACKNOWLEDGEMENT_TTL_MS = 5 * 60_000
const acknowledged = new Map<string, { terminal: GenerationTerminalSnapshot; expiresAt: number }>()

function prune(now: number) {
  for (const [id, record] of acknowledged) {
    if (record.expiresAt <= now) acknowledged.delete(id)
  }
}

export function recordAcknowledgedGenerationTerminal(
  generationId: string,
  terminal: GenerationTerminalSnapshot,
) {
  const now = Date.now()
  prune(now)
  acknowledged.set(generationId, { terminal, expiresAt: now + ACKNOWLEDGEMENT_TTL_MS })
}

export function takeAcknowledgedGenerationTerminal(
  generationId: string,
): GenerationTerminalSnapshot | null {
  const now = Date.now()
  prune(now)
  const record = acknowledged.get(generationId)
  acknowledged.delete(generationId)
  return record?.terminal ?? null
}
