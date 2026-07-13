import type {
  JobFailure,
  JobRecord,
  JobStatus,
  JsonObject,
  JsonValue,
} from './contracts'

export type JobAccounting = JsonObject
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

export type JobRetryResult = {
  accepted: boolean
  reason: 'not_found' | 'terminal' | 'cancel_requested' | 'stale_fence'
    | 'attempts_exhausted' | 'unsafe_effect' | null
  status: JobStatus | null
  availableAt: string | null
  eventSeq: number | null
  cancelRequested: boolean
}

export type JobFinalizeResult = {
  accepted: boolean
  replayed: boolean
  status: JobStatus
  result: JsonValue | null
  error: JobFailure | null
  eventSeq: number | null
}
