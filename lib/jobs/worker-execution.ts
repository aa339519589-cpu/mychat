import type { JobFence, JobRecord } from './contracts'
import { JobRuntimeError } from './errors'

export type ActiveExecution = {
  controller: AbortController
  renewStop: AbortController
  leaseDeadline: number
}

export function createActiveExecution(
  job: JobRecord,
  workerId: string,
): { execution: ActiveExecution; fence: JobFence } {
  const lease = job.lease
  if (!lease || lease.owner !== workerId || lease.version < 1) {
    throw new JobRuntimeError('JOB_LEASE_STALE', 'Claimed job has no valid fencing token')
  }
  const execution: ActiveExecution = {
    controller: new AbortController(),
    renewStop: new AbortController(),
    leaseDeadline: Date.parse(lease.expiresAt),
  }
  if (!Number.isFinite(execution.leaseDeadline)) {
    throw new JobRuntimeError('JOB_LEASE_STALE', 'Claimed job lease is malformed')
  }
  return {
    execution,
    fence: { jobId: job.id, workerId, leaseVersion: lease.version },
  }
}
