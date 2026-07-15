import {
  isJobIdentifier,
  isJobStatus,
  isJsonValue,
} from './contracts'
import { JobRuntimeError } from './errors'
import type { JobRepository } from './repository'
import type { JobResumeReason, JobResumeResult } from './repository-types'

type Rpc = (
  name: string,
  args: Record<string, unknown>,
) => Promise<Record<string, unknown>>

function malformed(): never {
  throw new JobRuntimeError(
    'JOB_DEPENDENCY_UNAVAILABLE',
    'Job repository returned malformed data',
    { details: { rpc: 'resume_awaiting_job' } },
  )
}

function nullableInteger(value: unknown): number | null {
  return value == null ? null : Number.isSafeInteger(value) ? Number(value) : malformed()
}

export async function resumeSupabaseJob(
  input: Parameters<JobRepository['resume']>[0],
  rpc: Rpc,
): Promise<JobResumeResult> {
  let serializedInput = ''
  try { serializedInput = JSON.stringify(input.resumeInput) } catch { /* validated below */ }
  if (!isJobIdentifier(input.jobId) || !isJobIdentifier(input.principalId)
    || !Number.isSafeInteger(input.expectedCheckpointVersion)
    || input.expectedCheckpointVersion < 1
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(input.idempotencyKey)
    || !isJsonValue(input.resumeInput) || Array.isArray(input.resumeInput)
    || input.resumeInput === null || typeof input.resumeInput !== 'object'
    || new TextEncoder().encode(serializedInput).byteLength > 65_536) {
    throw new JobRuntimeError('JOB_INVALID_INPUT', 'Invalid awaiting job resume input')
  }
  const result = await rpc('resume_awaiting_job', {
    input_job_id: input.jobId,
    input_principal_id: input.principalId,
    input_expected_checkpoint_version: input.expectedCheckpointVersion,
    input_idempotency_key: input.idempotencyKey,
    input_resume_input: input.resumeInput,
  })
  const allowedReasons: readonly JobResumeReason[] = [
    'not_found', 'not_awaiting_input', 'cancel_requested', 'checkpoint_missing',
    'checkpoint_not_resumable', 'checkpoint_version_conflict', 'idempotency_conflict', null,
  ]
  const reason = allowedReasons.includes(result.reason as JobResumeReason)
    ? result.reason as JobResumeReason
    : malformed()
  const status = result.status == null
    ? null
    : isJobStatus(result.status) ? result.status : malformed()
  const checkpointVersion = nullableInteger(result.checkpointVersion)
  const eventSeq = nullableInteger(result.eventSeq)
  if (typeof result.resumed !== 'boolean' || typeof result.replayed !== 'boolean'
    || (checkpointVersion !== null && checkpointVersion < 1)
    || (eventSeq !== null && eventSeq < 0)
    || (result.resumed && reason !== null)
    || (!result.resumed && reason === null)) return malformed()
  return {
    accepted: result.resumed,
    replayed: result.replayed,
    reason,
    status,
    checkpointVersion,
    eventSeq,
  }
}
