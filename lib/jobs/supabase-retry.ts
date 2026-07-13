import { assertJobFence, isIsoTimestamp, isJobStatus } from './contracts'
import { JobRuntimeError } from './errors'
import type { JobRepository } from './repository'
import type { JobRetryResult } from './repository-types'

type RetryInput = Parameters<JobRepository['retry']>[0]
type Rpc = (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>

function malformed(): never {
  throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Job repository returned malformed data', {
    details: { rpc: 'retry_job' },
  })
}

function nullableInteger(value: unknown): number | null {
  if (value == null) return null
  return Number.isSafeInteger(value) ? Number(value) : malformed()
}

export async function retrySupabaseJob(input: RetryInput, rpc: Rpc): Promise<JobRetryResult> {
  assertJobFence(input)
  if (!Number.isSafeInteger(input.delaySeconds)
    || input.delaySeconds < 1 || input.delaySeconds > 3_600) {
    throw new JobRuntimeError('JOB_INVALID_INPUT', 'Invalid job retry delay')
  }
  const result = await rpc('retry_job', {
    input_job_id: input.jobId,
    input_worker_id: input.workerId,
    input_lease_version: input.leaseVersion,
    input_error_class: input.error.class,
    input_error_code: input.error.code,
    input_delay_seconds: input.delaySeconds,
  })
  const status = result.status == null ? null : isJobStatus(result.status) ? result.status : malformed()
  const validReasons = new Set([
    'not_found', 'terminal', 'cancel_requested', 'stale_fence',
    'attempts_exhausted', 'unsafe_effect',
  ])
  const reason = result.reason === null ? null
    : typeof result.reason === 'string' && validReasons.has(result.reason)
      ? result.reason as JobRetryResult['reason']
      : malformed()
  const availableAt = result.availableAt === null ? null
    : isIsoTimestamp(result.availableAt) ? result.availableAt : malformed()
  return {
    accepted: result.retried === true,
    reason,
    status,
    availableAt,
    eventSeq: nullableInteger(result.eventSeq),
    cancelRequested: result.cancelRequested === true,
  }
}
