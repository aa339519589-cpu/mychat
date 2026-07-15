import { assertJobFence } from './contracts'
import { JobRuntimeError } from './errors'
import type { JobRepository } from './repository'
import type { JobAccountingMutationResult } from './repository-types'
import { statusOf } from './supabase-parsing'

type AccountingInput = Parameters<JobRepository['recordAccounting']>[0]
type Rpc = (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>

export async function recordSupabaseJobAccounting(
  input: AccountingInput,
  rpc: Rpc,
): Promise<JobAccountingMutationResult> {
  assertJobFence(input)
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1
    || input.ledgerEntries.length < 1 || input.ledgerEntries.length > 32) {
    throw new JobRuntimeError('JOB_INVALID_INPUT', 'Invalid job accounting input')
  }
  const result = await rpc('record_job_accounting', {
    input_job_id: input.jobId,
    input_worker_id: input.workerId,
    input_lease_version: input.leaseVersion,
    input_attempt: input.attempt,
    input_ledger_entries: input.ledgerEntries,
  })
  return {
    accepted: result.recorded === true,
    replayed: result.replayed === true,
    status: statusOf(result.status),
    cancelRequested: result.cancelRequested === true,
  }
}
