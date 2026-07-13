import type {
  EnqueueJobInput,
  JobEventDraft,
  JobFailure,
  JobFence,
  JobRecord,
  JobStatus,
  JobTerminalStatus,
  JsonValue,
} from './contracts'
import type {
  JobAccounting,
  JobClaimResult,
  JobEventsMutationResult,
  JobFencedMutationResult,
  JobFinalizeResult,
  JobOutboxInput,
  JobRenewResult,
  JobRetryResult,
} from './repository-types'

export type {
  JobAccounting,
  JobClaimResult,
  JobEventsMutationResult,
  JobFencedMutationResult,
  JobFinalizeResult,
  JobOutboxInput,
  JobRenewResult,
  JobRetryResult,
} from './repository-types'

export interface JobRepository {
  enqueue(input: EnqueueJobInput): Promise<{ created: boolean; job: JobRecord }>
  claim(input: {
    workerId: string
    queues: readonly string[]
    leaseSeconds: number
  }): Promise<JobClaimResult>
  renew(input: JobFence & { leaseSeconds: number }): Promise<JobRenewResult>
  retry(input: JobFence & {
    error: JobFailure
    delaySeconds: number
  }): Promise<JobRetryResult>
  appendEvents(input: JobFence & {
    events: readonly JobEventDraft[]
  }): Promise<JobEventsMutationResult>
  checkpoint(input: JobFence & {
    phase: string
    checkpoint: import('./contracts').JsonObject
    progress?: import('./contracts').JsonObject
    resumable: boolean
    status?: Extract<JobStatus, 'running' | 'awaiting_input'>
  }): Promise<JobFencedMutationResult>
  finalize(input: JobFence & {
    status: JobTerminalStatus
    result?: JsonValue
    error?: JobFailure
    ledgerEntries?: readonly JobAccounting[]
    outbox?: readonly JobOutboxInput[]
  }): Promise<JobFinalizeResult>
  cancel(input: {
    jobId: string
    principalId: string
    reason?: string
  }): Promise<{
    accepted: boolean
    replayed: boolean
    status: JobStatus
    result: JsonValue | null
    eventSeq: number | null
  }>
}
