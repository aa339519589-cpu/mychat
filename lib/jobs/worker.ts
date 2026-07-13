import { log } from '@/lib/logger'
import {
  JOB_LIMITS,
  assertJobFence,
  isJobIdentifier,
  isJobName,
  type JobFence,
  type JobRecord,
} from './contracts'
import { JobRuntimeError, isJobRuntimeError, normalizeJobError } from './errors'
import type { JobFinalizeResult, JobRepository } from './repository'
import { decideJobRetry } from './retry-policy'
import { boundedJobInteger, defaultJobSleep, nextJobBackoff } from './worker-config'
import { createActiveExecution, type ActiveExecution } from './worker-execution'
import type { JobExecutionContext, JobHandler, JobWorkerOptions } from './worker-types'

export type { JobExecutionContext, JobHandler, JobHandlerResult, JobWorkerOptions } from './worker-types'
export { nextJobBackoff } from './worker-config'
export class JobWorker {
  private readonly repository: JobRepository
  private readonly workerId: string
  private readonly queues: readonly string[]
  private readonly handlers: Readonly<Record<string, JobHandler>>
  private readonly concurrency: number
  private readonly leaseSeconds: number
  private readonly renewIntervalMs: number
  private readonly idleBackoffMinimumMs: number
  private readonly idleBackoffMaximumMs: number
  private readonly backoffJitter: number
  private readonly shutdownGraceMs: number
  private readonly now: () => number
  private readonly random: () => number
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>
  private readonly onFinalized?: JobWorkerOptions['onFinalized']
  private readonly claimAbort = new AbortController()
  private readonly active = new Map<string, ActiveExecution>()
  private stopping = false
  private running: Promise<void> | null = null
  private shutdownTimer: ReturnType<typeof setTimeout> | null = null

  constructor(options: JobWorkerOptions) {
    if (!isJobIdentifier(options.workerId) || options.queues.length < 1
      || options.queues.length > 16
      || options.queues.some(queue => !isJobName(queue, JOB_LIMITS.queueLength))) {
      throw new JobRuntimeError('JOB_INVALID_INPUT', 'Invalid job worker identity or queues')
    }
    this.repository = options.repository
    this.workerId = options.workerId
    this.queues = [...new Set(options.queues)]
    this.handlers = options.handlers
    this.concurrency = boundedJobInteger(
      options.concurrency ?? 1,
      1,
      JOB_LIMITS.workerConcurrencyMaximum,
      'job worker concurrency',
    )
    this.leaseSeconds = boundedJobInteger(
      options.leaseSeconds ?? 45,
      JOB_LIMITS.leaseSecondsMinimum,
      JOB_LIMITS.leaseSecondsMaximum,
      'job lease duration',
    )
    this.renewIntervalMs = boundedJobInteger(
      options.renewIntervalMs ?? Math.floor(this.leaseSeconds * 1_000 / 3),
      100,
      this.leaseSeconds * 500,
      'job lease renewal interval',
    )
    this.idleBackoffMinimumMs = boundedJobInteger(
      options.idleBackoffMinimumMs ?? 100,
      1,
      60_000,
      'job idle backoff minimum',
    )
    this.idleBackoffMaximumMs = boundedJobInteger(
      options.idleBackoffMaximumMs ?? 5_000,
      this.idleBackoffMinimumMs,
      60_000,
      'job idle backoff maximum',
    )
    this.backoffJitter = options.backoffJitter ?? 0.2
    if (!Number.isFinite(this.backoffJitter) || this.backoffJitter < 0 || this.backoffJitter > 1) {
      throw new JobRuntimeError('JOB_INVALID_INPUT', 'Invalid job worker backoff jitter')
    }
    this.shutdownGraceMs = boundedJobInteger(
      options.shutdownGraceMs ?? 30_000,
      0,
      300_000,
      'job worker shutdown grace period',
    )
    this.now = options.now ?? Date.now
    this.random = options.random ?? Math.random
    this.sleep = options.sleep ?? defaultJobSleep
    this.onFinalized = options.onFinalized
  }

  run(shutdownSignal?: AbortSignal): Promise<void> {
    if (this.running) return this.running
    if (shutdownSignal?.aborted) this.beginShutdown(shutdownSignal.reason)
    else shutdownSignal?.addEventListener('abort', () => {
      this.beginShutdown(shutdownSignal.reason)
    }, { once: true })
    const slots = Array.from({ length: this.concurrency }, (_, index) => this.runSlot(index))
    this.running = Promise.all(slots).then(() => undefined).finally(() => {
      if (this.shutdownTimer) clearTimeout(this.shutdownTimer)
      this.shutdownTimer = null
      this.running = null
    })
    return this.running
  }

  async shutdown(reason: unknown = new JobRuntimeError(
    'JOB_WORKER_SHUTDOWN',
    'Job worker is shutting down',
  )): Promise<void> {
    this.beginShutdown(reason)
    await this.running
  }

  private beginShutdown(reason: unknown): void {
    if (this.stopping) return
    this.stopping = true
    this.claimAbort.abort(reason)
    if (this.active.size === 0) return
    this.shutdownTimer = setTimeout(() => {
      for (const execution of this.active.values()) {
        if (!execution.controller.signal.aborted) execution.controller.abort(reason)
      }
    }, this.shutdownGraceMs)
  }

  private async runSlot(slot: number): Promise<void> {
    let backoffMs = this.idleBackoffMinimumMs
    while (!this.stopping) {
      try {
        const claim = await this.repository.claim({
          workerId: this.workerId,
          queues: this.queues,
          leaseSeconds: this.leaseSeconds,
        })
        if (this.stopping) return
        if (claim.acquired && claim.job) {
          backoffMs = this.idleBackoffMinimumMs
          await this.execute(claim.job)
          continue
        }
      } catch (error) {
        if (this.stopping) return
        const normalized = normalizeJobError(error)
        log.error('jobs', 'Job claim failed', {
          workerId: this.workerId,
          slot,
          code: normalized.code,
        })
      }
      const backoff = nextJobBackoff(
        backoffMs,
        this.idleBackoffMaximumMs,
        this.backoffJitter,
        this.random,
      )
      backoffMs = backoff.nextMs
      try {
        await this.sleep(backoff.waitMs, this.claimAbort.signal)
      } catch {
        if (!this.stopping) throw new JobRuntimeError('JOB_INTERNAL', 'Job worker backoff failed')
      }
    }
  }

  private async execute(job: JobRecord): Promise<void> {
    const startedAt = this.now()
    const { execution, fence } = createActiveExecution(job, this.workerId)
    this.active.set(job.id, execution)
    const context = this.context(job, fence, execution)
    const renewal = this.renewLease(fence, execution)
    try {
      const handler = this.handlers[job.type]
      if (!handler) throw new JobRuntimeError(
        'JOB_HANDLER_UNAVAILABLE',
        `No handler is registered for job type ${job.type}`,
      )
      const outcome = await handler(context)
      context.assertAuthority()
      if (outcome.status === 'awaiting_input') {
        await this.mutate(context, this.repository.checkpoint({
          ...fence,
          phase: outcome.phase,
          checkpoint: outcome.checkpoint,
          progress: outcome.progress,
          resumable: outcome.resumable,
          status: outcome.status,
        }))
      } else {
        const finalization = await this.repository.finalize({
          ...fence,
          status: outcome.status,
          result: 'result' in outcome ? outcome.result : undefined,
          error: outcome.status === 'failed' ? outcome.error : undefined,
          ledgerEntries: outcome.status === 'completed' ? outcome.ledgerEntries : undefined,
          outbox: outcome.status === 'completed' ? outcome.outbox : undefined,
        })
        if (this.observeFinalization(context, finalization)) {
          this.onFinalized?.({ job, status: outcome.status, durationMs: Math.max(0, this.now() - startedAt) })
        }
      }
    } catch (error) {
      await this.handleExecutionError(
        context,
        context.signal.aborted ? context.signal.reason : error,
        startedAt,
      )
    } finally {
      execution.renewStop.abort()
      await renewal
      this.active.delete(job.id)
    }
  }

  private context(job: JobRecord, fence: JobFence, execution: ActiveExecution): JobExecutionContext {
    const assertAuthority = () => {
      assertJobFence(fence)
      if (!execution.controller.signal.aborted && this.now() >= execution.leaseDeadline) {
        execution.controller.abort(new JobRuntimeError('JOB_LEASE_STALE', 'Job lease expired'))
      }
      if (execution.controller.signal.aborted) throw execution.controller.signal.reason
    }
    const context: JobExecutionContext = {
      job,
      fence,
      signal: execution.controller.signal,
      assertAuthority,
      appendEvents: async events => {
        assertAuthority()
        await this.mutate(context, this.repository.appendEvents({ ...fence, events }))
      },
      checkpoint: async input => {
        assertAuthority()
        await this.mutate(context, this.repository.checkpoint({
          ...fence,
          ...input,
          status: 'running',
        }))
      },
    }
    return context
  }

  private async mutate(
    context: JobExecutionContext,
    operation: Promise<{ accepted: boolean; cancelRequested: boolean }>,
  ): Promise<void> {
    const result = await operation
    if (result.cancelRequested) {
      const error = new JobRuntimeError('JOB_CANCEL_REQUESTED', 'Job cancellation was requested')
      const execution = this.active.get(context.job.id)
      execution?.controller.abort(error)
      throw error
    }
    if (!result.accepted) {
      const error = new JobRuntimeError('JOB_LEASE_STALE', 'Job fencing token was rejected')
      const execution = this.active.get(context.job.id)
      execution?.controller.abort(error)
      throw error
    }
  }

  private async renewLease(fence: JobFence, execution: ActiveExecution): Promise<void> {
    while (!execution.renewStop.signal.aborted) {
      try {
        await this.sleep(this.renewIntervalMs, execution.renewStop.signal)
      } catch {
        return
      }
      if (execution.renewStop.signal.aborted) return
      if (this.now() >= execution.leaseDeadline) {
        execution.controller.abort(new JobRuntimeError('JOB_LEASE_STALE', 'Job lease expired'))
        return
      }
      let renewal
      try {
        renewal = await this.repository.renew({ ...fence, leaseSeconds: this.leaseSeconds })
      } catch (error) {
        log.error('jobs', 'Job lease renewal failed', {
          jobId: fence.jobId,
          workerId: this.workerId,
          leaseVersion: fence.leaseVersion,
          code: normalizeJobError(error).code,
        })
        continue
      }
      if (renewal.state === 'lost') {
        execution.controller.abort(new JobRuntimeError('JOB_LEASE_STALE', 'Job lease was lost'))
        return
      }
      if (renewal.state === 'renewed' && renewal.leaseExpiresAt) {
        execution.leaseDeadline = Date.parse(renewal.leaseExpiresAt)
      }
      if (renewal.cancelRequested) {
        execution.controller.abort(new JobRuntimeError(
          'JOB_CANCEL_REQUESTED',
          'Job cancellation was requested',
        ))
        return
      }
    }
  }

  private observeFinalization(context: JobExecutionContext, result: JobFinalizeResult): boolean {
    if (result.accepted) return true
    if (result.replayed) {
      log.info('jobs', 'Job terminal finalization replayed', {
        jobId: context.job.id,
        status: result.status,
      })
      return true
    }
    const error = new JobRuntimeError('JOB_LEASE_STALE', 'Job finalization fencing token was rejected')
    this.active.get(context.job.id)?.controller.abort(error)
    throw error
  }

  private async handleExecutionError(
    context: JobExecutionContext,
    error: unknown,
    startedAt: number,
  ): Promise<void> {
    const normalized = normalizeJobError(error)
    if (normalized.code === 'JOB_LEASE_STALE' || normalized.code === 'JOB_WORKER_SHUTDOWN') {
      log.warn('jobs', 'Job execution stopped without finalization', {
        jobId: context.job.id,
        workerId: this.workerId,
        leaseVersion: context.fence.leaseVersion,
        code: normalized.code,
      })
      return
    }
    let terminalError = normalized
    let poisonReason: string | null = null
    if (normalized.code !== 'JOB_CANCEL_REQUESTED' && normalized.retryable) {
      const retry = await decideJobRetry({
        context,
        error: normalized,
        repository: this.repository,
        workerId: this.workerId,
        random: this.random,
      })
      if (retry.action === 'stop') return
      terminalError = retry.error
      poisonReason = retry.poisonReason
    }
    try {
      if (terminalError.code !== 'JOB_CANCEL_REQUESTED') context.assertAuthority()
      const finalization = await this.repository.finalize({
        ...context.fence,
        status: terminalError.code === 'JOB_CANCEL_REQUESTED' ? 'cancelled' : 'failed',
        error: terminalError.code === 'JOB_CANCEL_REQUESTED' ? undefined : terminalError.toFailure(),
        outbox: poisonReason ? [{
          kind: 'jobs.poison',
          dedupeKey: `${context.job.id}:poison`,
          payload: {
            jobId: context.job.id,
            type: context.job.type,
            reason: poisonReason,
            attempt: context.job.attempt,
            lastErrorCode: normalized.code,
          },
        }] : undefined,
      })
      if (this.observeFinalization(context, finalization)) {
        this.onFinalized?.({
          job: context.job,
          status: terminalError.code === 'JOB_CANCEL_REQUESTED' ? 'cancelled' : 'failed',
          durationMs: Math.max(0, this.now() - startedAt),
        })
      }
    } catch (finalizeError) {
      if (!isJobRuntimeError(finalizeError) || finalizeError.code !== 'JOB_LEASE_STALE') {
        log.error('jobs', 'Job finalization after failure failed', {
          jobId: context.job.id,
          code: normalizeJobError(finalizeError).code,
        })
      }
    }
  }
}
