import type {
  JobEventDraft,
  JobFailure,
  JobFence,
  JobRecord,
  JsonObject,
  JsonValue,
} from './contracts'
import type { JobAccounting, JobOutboxInput, JobRepository } from './repository'

export type JobHandlerResult =
  | {
      status: 'completed'
      result?: JsonValue
      ledgerEntries?: readonly JobAccounting[]
      outbox?: readonly JobOutboxInput[]
    }
  | { status: 'failed'; error: JobFailure; result?: JsonValue }
  | { status: 'cancelled'; result?: JsonValue }
  | {
      status: 'awaiting_input'
      phase: string
      checkpoint: JsonObject
      progress?: JsonObject
      resumable: boolean
    }

export type JobExecutionContext = {
  readonly job: JobRecord
  readonly fence: JobFence
  readonly signal: AbortSignal
  assertAuthority: () => void
  appendEvents: (events: readonly JobEventDraft[]) => Promise<void>
  checkpoint: (input: {
    phase: string
    checkpoint: JsonObject
    progress?: JsonObject
    resumable: boolean
  }) => Promise<void>
}

export type JobHandler = (context: JobExecutionContext) => Promise<JobHandlerResult>

export type JobWorkerOptions = {
  repository: JobRepository
  workerId: string
  queues: readonly string[]
  handlers: Readonly<Record<string, JobHandler>>
  concurrency?: number
  leaseSeconds?: number
  renewIntervalMs?: number
  idleBackoffMinimumMs?: number
  idleBackoffMaximumMs?: number
  backoffJitter?: number
  shutdownGraceMs?: number
  now?: () => number
  random?: () => number
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>
  onFinalized?: (input: {
    job: JobRecord
    status: 'completed' | 'failed' | 'cancelled'
    durationMs: number
  }) => void
}
