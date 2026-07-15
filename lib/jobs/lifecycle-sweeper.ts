import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/admin'
import { log } from '@/lib/logger'
import { JobRuntimeError } from './errors'
import { boundedJobInteger, defaultJobSleep } from './worker-config'

export type JobLifecycleSweepResult = {
  outboxDeleted: number
  streamLeasesDeleted: number
  expiredReservationsReclaimed: number
}

type Options = {
  createAdminClient?: () => SupabaseClient | null
  intervalMs?: number
  batchSize?: number
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>
}

function nonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null
}

export class JobLifecycleSweeper {
  private readonly createClient: () => SupabaseClient | null
  private readonly intervalMs: number
  private readonly batchSize: number
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>

  constructor(options: Options = {}) {
    this.createClient = options.createAdminClient ?? createAdminClient
    this.intervalMs = boundedJobInteger(
      options.intervalMs ?? 5 * 60_000,
      10_000,
      24 * 60 * 60_000,
      'lifecycle sweep interval',
    )
    this.batchSize = boundedJobInteger(options.batchSize ?? 500, 1, 2_000, 'lifecycle sweep batch')
    this.sleep = options.sleep ?? defaultJobSleep
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const result = await this.runOnce()
        if (result.outboxDeleted > 0 || result.streamLeasesDeleted > 0
          || result.expiredReservationsReclaimed > 0) {
          log.info('jobs', 'Lifecycle sweep completed', result)
        }
      } catch (error) {
        log.warn('jobs', 'Lifecycle sweep failed', {
          code: error instanceof JobRuntimeError ? error.code : 'JOB_INTERNAL',
        })
      }
      try { await this.sleep(this.intervalMs, signal) } catch {
        if (!signal.aborted) throw new Error('Lifecycle sweeper wait failed')
      }
    }
  }

  async runOnce(): Promise<JobLifecycleSweepResult> {
    const client = this.createClient()
    if (!client) throw new JobRuntimeError(
      'JOB_DEPENDENCY_UNAVAILABLE',
      'Lifecycle sweeper is unavailable',
    )
    const { data, error } = await client.rpc('sweep_job_lifecycle', {
      input_batch_size: this.batchSize,
    })
    const normalized = Array.isArray(data) ? data[0] : data
    const row = normalized !== null && typeof normalized === 'object' && !Array.isArray(normalized)
      ? normalized as Record<string, unknown>
      : null
    const outboxDeleted = nonNegativeInteger(row?.outboxDeleted)
    const streamLeasesDeleted = nonNegativeInteger(row?.streamLeasesDeleted)
    const expiredReservationsReclaimed = nonNegativeInteger(row?.expiredReservationsReclaimed)
    if (error || outboxDeleted === null || streamLeasesDeleted === null
      || expiredReservationsReclaimed === null) {
      throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Lifecycle sweep returned malformed data')
    }
    return { outboxDeleted, streamLeasesDeleted, expiredReservationsReclaimed }
  }
}
