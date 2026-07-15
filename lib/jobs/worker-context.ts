import {
  assertJobFence,
  type JobFence,
  type JobRecord,
} from './contracts'
import { log } from '@/lib/logger'
import { JobBudgetController } from './budget'
import { JobRuntimeError } from './errors'
import type { JobRepository } from './repository'
import type { JobFinalizeResult } from './repository'
import type { ActiveExecution } from './worker-execution'
import type { JobExecutionContext } from './worker-types'

type FencedMutationResult = { accepted: boolean; cancelRequested: boolean }

function observeFencedMutation(
  execution: ActiveExecution,
  result: FencedMutationResult,
): void {
  if (result.cancelRequested) {
    const error = new JobRuntimeError('JOB_CANCEL_REQUESTED', 'Job cancellation was requested')
    execution.controller.abort(error)
    throw error
  }
  if (!result.accepted) {
    const error = new JobRuntimeError('JOB_LEASE_STALE', 'Job fencing token was rejected')
    execution.controller.abort(error)
    throw error
  }
}

export async function assertFencedMutation(
  execution: ActiveExecution,
  operation: Promise<FencedMutationResult>,
): Promise<void> {
  observeFencedMutation(execution, await operation)
}

export function createJobExecutionContext(input: {
  job: JobRecord
  fence: JobFence
  execution: ActiveExecution
  budget: JobBudgetController
  repository: JobRepository
  now: () => number
}): JobExecutionContext {
  const { job, fence, execution, budget, repository, now } = input
  let checkpointVersion = job.checkpoint?.version ?? 0
  const assertAuthority = () => {
    assertJobFence(fence)
    if (!execution.controller.signal.aborted && now() >= execution.leaseDeadline) {
      execution.controller.abort(new JobRuntimeError('JOB_LEASE_STALE', 'Job lease expired'))
    }
    if (execution.controller.signal.aborted) throw execution.controller.signal.reason
    budget.assertWithinLimits()
  }
  const context: JobExecutionContext = {
    job,
    fence,
    signal: execution.controller.signal,
    budget,
    assertAuthority,
    reportAccounting: entry => {
      assertAuthority()
      budget.reportAccounting(entry)
    },
    flushAccounting: async () => {
      assertAuthority()
      const cancelRequested = await persistJobAccounting({
        context, budget, repository, execution, forceResource: false,
      })
      if (cancelRequested) {
        const error = new JobRuntimeError('JOB_CANCEL_REQUESTED', 'Job cancellation was requested')
        execution.controller.abort(error)
        throw error
      }
      assertAuthority()
    },
    appendEvents: async events => {
      assertAuthority()
      await assertFencedMutation(execution, repository.appendEvents({ ...fence, events }))
    },
    checkpoint: async checkpoint => {
      assertAuthority()
      const ledgerEntries = budget.pendingLedgerEntries()
      const result = await repository.checkpointWithAccounting({
        ...fence,
        ...checkpoint,
        attempt: job.attempt,
        expectedCheckpointVersion: checkpointVersion,
        checkpointKey: `${job.id}:attempt:${job.attempt}:checkpoint:${checkpointVersion + 1}`,
        status: checkpoint.status ?? 'running',
        ledgerEntries,
      })
      observeFencedMutation(execution, result)
      if (result.checkpointVersion === null) {
        throw new JobRuntimeError('JOB_INTERNAL', 'Atomic checkpoint omitted its version')
      }
      if (ledgerEntries.length > 0) budget.acknowledgeLedgerEntries(ledgerEntries)
      checkpointVersion = result.checkpointVersion
    },
  }
  return context
}

export async function persistJobAccounting(input: {
  context: JobExecutionContext
  budget: JobBudgetController
  repository: JobRepository
  execution: ActiveExecution
  forceResource?: boolean
}): Promise<boolean> {
  const { context, budget, repository, execution } = input
  const ledgerEntries = budget.pendingLedgerEntries(input.forceResource ?? true)
  if (ledgerEntries.length === 0) return false
  const result = await repository.recordAccounting({
    ...context.fence,
    attempt: context.job.attempt,
    ledgerEntries,
  })
  if (!result.accepted) {
    const error = new JobRuntimeError('JOB_LEASE_STALE', 'Job accounting fencing token was rejected')
    execution.controller.abort(error)
    throw error
  }
  budget.acknowledgeLedgerEntries(ledgerEntries)
  return result.cancelRequested
}

export function observeJobFinalization(input: {
  context: JobExecutionContext
  result: JobFinalizeResult
  execution: ActiveExecution
}): boolean {
  const { context, result, execution } = input
  if (result.accepted) return true
  if (result.replayed) {
    log.info('jobs', 'Job terminal finalization replayed', {
      jobId: context.job.id,
      status: result.status,
    })
    return true
  }
  const error = new JobRuntimeError('JOB_LEASE_STALE', 'Job finalization fencing token was rejected')
  execution.controller.abort(error)
  throw error
}
