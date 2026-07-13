import type { GenerationReadResult, GenerationReadUnavailableReason } from './persist'
import type { GenerationDatabaseRow, GenerationDurability } from './types'

type LocalGeneration = {
  record: { durability: GenerationDurability }
}

export type GenerationStreamSource =
  | { kind: 'database'; row: GenerationDatabaseRow }
  | { kind: 'local' }
  | { kind: 'missing' }
  | {
      kind: 'coordination_unavailable'
      reason: 'durable_row_missing' | GenerationReadUnavailableReason
    }

/**
 * Database authority always wins. A successful not-found read may fall back to
 * memory only for a job that was explicitly created as ephemeral. In
 * particular, a network error is never interpreted as absence.
 */
export function selectGenerationStreamSource(
  database: GenerationReadResult<GenerationDatabaseRow>,
  local: LocalGeneration | undefined,
): GenerationStreamSource {
  if (database.kind === 'found') return { kind: 'database', row: database.value }
  if (database.kind === 'unavailable') {
    return { kind: 'coordination_unavailable', reason: database.reason }
  }
  if (!local) return { kind: 'missing' }
  if (local.record.durability === 'ephemeral') return { kind: 'local' }
  return { kind: 'coordination_unavailable', reason: 'durable_row_missing' }
}
