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
  JobAccountingMutationResult,
  JobClaimResult,
  JobCheckpointAccountingMutationResult,
  JobEventsMutationResult,
  JobFinalizeResult,
  JobOutboxInput,
  JobRenewResult,
  JobResumeResult,
  JobRetryResult,
} from './repository-types'

export type {
  JobAccounting,
  JobAccountingMutationResult,
  JobClaimResult,
  JobCheckpointAccountingReason,
  JobCheckpointAccountingMutationResult,
  JobEventsMutationResult,
  JobFencedMutationResult,
  JobFinalizeResult,
  JobOutboxInput,
  JobRenewResult,
  JobResumeResult,
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
  checkpointWithAccounting(input: JobFence & {
    attempt: number
    expectedCheckpointVersion: number
    checkpointKey: string
    phase: string
    checkpoint: import('./contracts').JsonObject
    progress?: import('./contracts').JsonObject
    resumable: boolean
    status?: Extract<JobStatus, 'running' | 'awaiting_input'>
    ledgerEntries: readonly JobAccounting[]
  }): Promise<JobCheckpointAccountingMutationResult>
  recordAccounting(input: JobFence & {
    attempt: number
    ledgerEntries: readonly JobAccounting[]
  }): Promise<JobAccountingMutationResult>
  resume(input: {
    jobId: string
    principalId: string
    expectedCheckpointVersion: number
    idempotencyKey: string
    resumeInput: import('./contracts').JsonObject
  }): Promise<JobResumeResult>
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
