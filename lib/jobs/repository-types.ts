import type {
  JobFailure,
  JobRecord,
  JobStatus,
  JobTerminalStatus,
  JsonObject,
  JsonValue,
} from './contracts'

export type JobAccounting = JsonObject & {
  idempotencyKey: string
  reason: string
  direction?: 'debit' | 'credit'
  weightedTokens?: number
  rawTokens?: number
  model?: string
  provider?: string
  costEstimate?: number
  costMicros?: number
  currency?: string
  metadata?: JsonObject
}
export type JobOutboxInput = {
  kind: string
  payload: JsonValue
  dedupeKey?: string
}

export type JobClaimResult = {
  acquired: boolean
  reason: 'empty' | 'active' | 'attempts_exhausted' | 'claimed'
  job: JobRecord | null
}

export type JobRenewResult = {
  state: 'renewed' | 'lost' | 'unavailable'
  status: JobStatus | null
  leaseExpiresAt: string | null
  cancelRequested: boolean
}

export type JobEventsMutationResult = {
  accepted: boolean
  replayed: boolean
  status: JobStatus | null
  fromSeq: number | null
  toSeq: number | null
  cancelRequested: boolean
}

export type JobFencedMutationResult = {
  accepted: boolean
  status: JobStatus | null
  cancelRequested: boolean
}

export type JobAccountingMutationResult = JobFencedMutationResult & {
  replayed: boolean
}

export type JobCheckpointAccountingReason = 'not_found' | 'terminal' | 'cancel_requested'
  | 'stale_fence' | 'stale_attempt' | 'checkpoint_version_conflict'
  | 'accounting_rejected' | null

export type JobCheckpointAccountingMutationResult = JobFencedMutationResult & {
  replayed: boolean
  reason: JobCheckpointAccountingReason
  checkpointVersion: number | null
}

export type JobRetryResult = {
  accepted: boolean
  reason: 'not_found' | 'terminal' | 'cancel_requested' | 'stale_fence'
    | 'attempts_exhausted' | 'unsafe_effect' | null
  status: JobStatus | null
  availableAt: string | null
  eventSeq: number | null
  cancelRequested: boolean
}

export type JobResumeReason = 'not_found' | 'not_awaiting_input' | 'cancel_requested'
  | 'checkpoint_missing' | 'checkpoint_not_resumable' | 'checkpoint_version_conflict'
  | 'idempotency_conflict' | null

export type JobResumeResult = {
  accepted: boolean
  replayed: boolean
  reason: JobResumeReason
  status: JobStatus | null
  checkpointVersion: number | null
  eventSeq: number | null
}

export type JobFinalizeResult = {
  accepted: boolean
  replayed: boolean
  status: JobTerminalStatus
  result: JsonValue | null
  error: JobFailure | null
  eventSeq: number | null
}
