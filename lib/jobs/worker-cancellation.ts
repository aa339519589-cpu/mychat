import type { JobFence } from './contracts'
import { JobRuntimeError } from './errors'
import type { JobRepository } from './repository'
import type { ActiveExecution } from './worker-execution'
import type { JobWorkerOptions } from './worker-types'

/** Cancellation observation does not renew or grant execution authority. */
export async function observeJobCancellation(input: {
  repository: JobRepository
  fence: JobFence
  execution: ActiveExecution
  sleep: NonNullable<JobWorkerOptions['sleep']>
}): Promise<void> {
  const { execution } = input
  const read = input.repository.cancellationRequested?.bind(input.repository)
  if (!read) return
  while (!execution.renewStop.signal.aborted && !execution.controller.signal.aborted) {
    try {
      await input.sleep(1_000, execution.renewStop.signal)
      if (execution.renewStop.signal.aborted || execution.controller.signal.aborted) return
      if (await read(input.fence, execution.renewStop.signal)) {
        execution.controller.abort(new JobRuntimeError('JOB_CANCEL_REQUESTED', 'Job cancellation was requested'))
        return
      }
    } catch {
      if (execution.renewStop.signal.aborted) return
      // The independent renewal loop still enforces expiry during an outage.
    }
  }
}
