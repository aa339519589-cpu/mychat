import { log } from '@/lib/logger'
import {
  abortGeneration,
  getGenerationForUser,
  reconcileGeneration,
} from './runtime'
import { requestGenerationCancellation } from './lease'
import {
  isGenerationTerminalSnapshot,
  isTerminalGenerationStatus,
  type GenerationTerminalSnapshot,
} from './types'

type CancellationDependencies = {
  requestCancellation?: typeof requestGenerationCancellation
  getLocalGeneration?: typeof getGenerationForUser
  abortLocalGeneration?: typeof abortGeneration
  reconcileLocalGeneration?: typeof reconcileGeneration
}

export type CoordinatedCancellationResult =
  | { kind: 'unavailable' }
  | { kind: 'not_found' }
  | { kind: 'transitioning' }
  | {
      kind: 'terminal'
      accepted: boolean
      runnerLocal: boolean
      terminal: GenerationTerminalSnapshot
    }

/** The database CAS must win before a local provider runner is ever aborted. */
export async function coordinateGenerationCancellation(
  input: { userId: string; generationId: string },
  dependencies: CancellationDependencies = {},
): Promise<CoordinatedCancellationResult> {
  const result = await (dependencies.requestCancellation ?? requestGenerationCancellation)(input)
  if (!result.ok) return { kind: 'unavailable' }
  if (!result.status) return { kind: 'not_found' }
  if (!isTerminalGenerationStatus(result.status)) return { kind: 'transitioning' }
  const terminal = {
    status: result.status,
    content: result.content ?? '',
    thinking: result.thinking ?? '',
    sequence: result.sequence ?? 0,
    error: result.error ?? null,
    media: result.media,
  }
  if (!isGenerationTerminalSnapshot(terminal)) return { kind: 'unavailable' }

  const entry = (dependencies.getLocalGeneration ?? getGenerationForUser)(
    input.generationId,
    input.userId,
  )
  if (entry) {
    ;(dependencies.abortLocalGeneration ?? abortGeneration)(input.generationId, input.userId)
    ;(dependencies.reconcileLocalGeneration ?? reconcileGeneration)(
      input.generationId,
      input.userId,
      result,
    )
  }
  log.info('generation', 'cancel api', {
    generationId: input.generationId,
    userId: input.userId,
    runnerLocal: Boolean(entry),
    accepted: result.accepted,
    status: result.status,
  })
  return {
    kind: 'terminal',
    accepted: result.accepted,
    runnerLocal: Boolean(entry),
    terminal,
  }
}
