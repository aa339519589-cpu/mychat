import { log } from '@/lib/logger'
import { JobRuntimeError, normalizeJobError } from './errors'
import type { JobRepository } from './repository'
import type { JobExecutionContext } from './worker-types'

export type RetryDecision =
  | { action: 'stop' }
  | { action: 'finalize'; error: JobRuntimeError; poisonReason: string | null }

export async function decideJobRetry(input: {
  context: JobExecutionContext
  error: JobRuntimeError
  repository: JobRepository
  workerId: string
  random: () => number
}): Promise<RetryDecision> {
  const { context, error, repository, workerId, random } = input
  if (context.job.attempt >= context.job.maxAttempts) return {
    action: 'finalize',
    error: new JobRuntimeError(
      'JOB_ATTEMPTS_EXHAUSTED',
      'Job retry attempts were exhausted',
      { details: { lastErrorCode: error.code, attempt: context.job.attempt } },
    ),
    poisonReason: 'attempts_exhausted',
  }

  const baseDelay = Math.min(300, 2 ** Math.min(context.job.attempt, 8))
  const delaySeconds = Math.max(1, Math.round(baseDelay * (0.8 + (random() * 0.4))))
  try {
    context.assertAuthority()
    const retry = await repository.retry({
      ...context.fence,
      error: error.toFailure(),
      delaySeconds,
    })
    if (retry.accepted) {
      log.warn('jobs', 'Job retry scheduled', {
        jobId: context.job.id,
        workerId,
        attempt: context.job.attempt,
        availableAt: retry.availableAt,
        code: error.code,
      })
      return { action: 'stop' }
    }
    if (retry.cancelRequested || retry.reason === 'cancel_requested') return {
      action: 'finalize',
      error: new JobRuntimeError('JOB_CANCEL_REQUESTED', 'Job cancellation was requested'),
      poisonReason: null,
    }
    if (retry.reason === 'unsafe_effect') return {
      action: 'finalize',
      error: new JobRuntimeError(
        'JOB_RETRY_UNSAFE',
        'Job cannot be retried after an uncertain side effect',
        { details: { lastErrorCode: error.code, attempt: context.job.attempt } },
      ),
      poisonReason: 'unsafe_effect',
    }
    if (retry.reason === 'attempts_exhausted') return {
      action: 'finalize',
      error: new JobRuntimeError(
        'JOB_ATTEMPTS_EXHAUSTED',
        'Job retry attempts were exhausted',
        { details: { lastErrorCode: error.code, attempt: context.job.attempt } },
      ),
      poisonReason: 'attempts_exhausted',
    }
    log.warn('jobs', 'Job retry fence was not accepted', {
      jobId: context.job.id,
      workerId,
      reason: retry.reason,
    })
    return { action: 'stop' }
  } catch (retryError) {
    log.error('jobs', 'Job retry scheduling failed; lease recovery will decide', {
      jobId: context.job.id,
      workerId,
      code: normalizeJobError(retryError).code,
    })
    return { action: 'stop' }
  }
}
