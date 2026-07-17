import { assertJobFence, isJobIdentifier } from './contracts'
import { JobRuntimeError } from './errors'
import type { JobRepository } from './repository'
import type {
  JobCheckpointAccountingMutationResult,
  JobCheckpointAccountingReason,
} from './repository-types'
import { malformed, nullableInteger, statusOf } from './supabase-parsing'
import type { RpcArgs } from '@/lib/supabase/types'
import { toJson } from '@/lib/supabase/json'

type CheckpointInput = Parameters<JobRepository['checkpointWithAccounting']>[0]
type Rpc = (
  name: 'checkpoint_job_with_accounting',
  args: RpcArgs<'checkpoint_job_with_accounting'>,
) => Promise<Record<string, unknown>>

const CHECKPOINT_REASONS = new Set<JobCheckpointAccountingReason>([
  'not_found', 'terminal', 'cancel_requested', 'stale_fence', 'stale_attempt',
  'checkpoint_version_conflict', 'accounting_rejected', null,
])

export async function checkpointSupabaseJobWithAccounting(
  input: CheckpointInput,
  rpc: Rpc,
): Promise<JobCheckpointAccountingMutationResult> {
  assertJobFence(input)
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1
    || !Number.isSafeInteger(input.expectedCheckpointVersion) || input.expectedCheckpointVersion < 0
    || !isJobIdentifier(input.checkpointKey) || input.checkpointKey.length > 300
    || input.ledgerEntries.length > 32) {
    throw new JobRuntimeError('JOB_INVALID_INPUT', 'Invalid atomic job checkpoint input')
  }
  const result = await rpc('checkpoint_job_with_accounting', {
    input_job_id: input.jobId,
    input_worker_id: input.workerId,
    input_lease_version: input.leaseVersion,
    input_attempt: input.attempt,
    input_expected_checkpoint_version: input.expectedCheckpointVersion,
    input_checkpoint_key: input.checkpointKey,
    input_phase: input.phase,
    input_checkpoint: input.checkpoint,
    input_progress: input.progress ?? {},
    input_resumable: input.resumable,
    input_status: input.status ?? 'running',
    input_ledger_entries: toJson([...input.ledgerEntries]),
  })
  const checkpointVersion = nullableInteger(result.checkpointVersion)
  const reason = typeof result.reason === 'string' ? result.reason : null
  if (!CHECKPOINT_REASONS.has(reason as JobCheckpointAccountingReason)
    || (result.checkpointed === true && checkpointVersion === null)) {
    return malformed('checkpoint_job_with_accounting')
  }
  return {
    accepted: result.checkpointed === true,
    replayed: result.replayed === true,
    reason: reason as JobCheckpointAccountingReason,
    status: statusOf(result.status),
    checkpointVersion,
    cancelRequested: result.cancelRequested === true,
  }
}
