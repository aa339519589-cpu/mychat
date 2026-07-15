import { log } from '@/lib/logger'
import { normalizeJobError } from './errors'
import {
  JOB_OUTBOX_TOPICS,
  type JobOutboxMessage,
  type JobOutboxRepository,
} from './outbox-contracts'
import { boundedJobInteger, defaultJobSleep, nextJobBackoff } from './worker-config'

export type JobOutboxDispatcherOptions = {
  repository: JobOutboxRepository
  workerId: string
  lockSeconds?: number
  idleBackoffMinimumMs?: number
  idleBackoffMaximumMs?: number
  backoffJitter?: number
  random?: () => number
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>
  observe?: (message: JobOutboxMessage) => void | Promise<void>
}

export class JobOutboxDispatcher {
  private readonly repository: JobOutboxRepository
  private readonly workerId: string
  private readonly lockSeconds: number
  private readonly idleBackoffMinimumMs: number
  private readonly idleBackoffMaximumMs: number
  private readonly backoffJitter: number
  private readonly random: () => number
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>
  private readonly observe: (message: JobOutboxMessage) => void | Promise<void>

  constructor(options: JobOutboxDispatcherOptions) {
    if (!options.workerId || options.workerId.length > 256) throw new TypeError('Invalid outbox worker id')
    this.repository = options.repository
    this.workerId = options.workerId
    this.lockSeconds = boundedJobInteger(options.lockSeconds ?? 60, 15, 900, 'outbox lock duration')
    this.idleBackoffMinimumMs = boundedJobInteger(
      options.idleBackoffMinimumMs ?? 250,
      1,
      60_000,
      'outbox idle backoff minimum',
    )
    this.idleBackoffMaximumMs = boundedJobInteger(
      options.idleBackoffMaximumMs ?? 5_000,
      this.idleBackoffMinimumMs,
      60_000,
      'outbox idle backoff maximum',
    )
    this.backoffJitter = options.backoffJitter ?? 0.2
    if (!Number.isFinite(this.backoffJitter) || this.backoffJitter < 0 || this.backoffJitter > 1) {
      throw new TypeError('Invalid outbox backoff jitter')
    }
    this.random = options.random ?? Math.random
    this.sleep = options.sleep ?? defaultJobSleep
    this.observe = options.observe ?? (message => {
      const data = { outboxId: message.id, jobId: message.jobId, attempt: message.attempt }
      if (message.topic === 'jobs.poison') log.error('outbox', 'Poison job published', data)
      else log.info('outbox', 'Job lifecycle event published', { ...data, topic: message.topic })
    })
  }

  async run(signal: AbortSignal): Promise<void> {
    let backoffMs = this.idleBackoffMinimumMs
    while (!signal.aborted) {
      let worked = false
      try {
        worked = await this.runOnce()
      } catch (error) {
        if (signal.aborted) return
        const normalized = normalizeJobError(error)
        log.error('outbox', 'Outbox claim failed', { workerId: this.workerId, code: normalized.code })
      }
      if (worked) {
        backoffMs = this.idleBackoffMinimumMs
        continue
      }
      const backoff = nextJobBackoff(
        backoffMs,
        this.idleBackoffMaximumMs,
        this.backoffJitter,
        this.random,
      )
      backoffMs = backoff.nextMs
      try {
        await this.sleep(backoff.waitMs, signal)
      } catch {
        if (!signal.aborted) throw new Error('Outbox dispatcher backoff failed')
      }
    }
  }

  async runOnce(): Promise<boolean> {
    const claim = await this.repository.claim({
      workerId: this.workerId,
      topics: JOB_OUTBOX_TOPICS,
      lockSeconds: this.lockSeconds,
    })
    if (!claim.acquired) return false
    const message = claim.message
    const renewalStop = new AbortController()
    let renewalError: unknown
    const renewal = this.renewLease(message, renewalStop.signal).catch(error => {
      renewalError = error
    })
    try {
      if (message.topic === 'assets.cleanup') {
        const deleted = await this.repository.cleanupAssets({ message, workerId: this.workerId })
        log.info('outbox', 'Generated media cleanup published', {
          outboxId: message.id,
          jobId: message.jobId,
          deleted,
        })
      } else if (message.topic === 'payloads.cleanup') {
        const deleted = await this.repository.cleanupPayload({ message, workerId: this.workerId })
        log.info('outbox', 'Job payload cleanup published', {
          outboxId: message.id,
          jobId: message.jobId,
          deleted,
        })
      } else {
        await this.observe(message)
      }
      if (renewalError) throw renewalError
      await this.repository.publish({
        outboxId: message.id,
        workerId: this.workerId,
        lockVersion: message.lockVersion,
      })
    } catch (error) {
      const normalized = normalizeJobError(error)
      const retrySeconds = Math.min(3_600, 2 ** Math.min(12, message.attempt - 1) * 5)
      try {
        await this.repository.fail({
          outboxId: message.id,
          workerId: this.workerId,
          lockVersion: message.lockVersion,
          errorCode: normalized.code,
          retrySeconds,
        })
      } catch (failureError) {
        log.error('outbox', 'Outbox failure acknowledgement failed', {
          outboxId: message.id,
          code: normalizeJobError(failureError).code,
        })
      }
      log.warn('outbox', 'Outbox delivery scheduled for retry', {
        outboxId: message.id,
        jobId: message.jobId,
        topic: message.topic,
        attempt: message.attempt,
        code: normalized.code,
        retrySeconds,
      })
    } finally {
      renewalStop.abort()
      await renewal
    }
    return true
  }

  private async renewLease(message: JobOutboxMessage, signal: AbortSignal): Promise<void> {
    const renewalIntervalMs = Math.max(1_000, Math.floor(this.lockSeconds * 1_000 / 3))
    while (!signal.aborted) {
      try {
        await this.sleep(renewalIntervalMs, signal)
      } catch {
        return
      }
      if (signal.aborted) return
      await this.repository.renew({
        outboxId: message.id,
        workerId: this.workerId,
        lockVersion: message.lockVersion,
        lockSeconds: this.lockSeconds,
      })
    }
  }
}
