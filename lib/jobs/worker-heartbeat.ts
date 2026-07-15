import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/admin'
import { log } from '@/lib/logger'
import { isJobIdentifier, isJobName } from './contracts'
import { defaultJobSleep } from './worker-config'

type HeartbeatRpcResponse = {
  data: unknown
  error: { code?: string } | null
}

type HeartbeatRpc = PromiseLike<HeartbeatRpcResponse> & {
  abortSignal?: (signal: AbortSignal) => PromiseLike<HeartbeatRpcResponse>
}

export type JobWorkerHeartbeatOptions = {
  workerId: string
  revision: string
  queues: readonly string[]
  capacity: number
  draining?: boolean
  intervalMs?: number
  rpcTimeoutMs?: number
  startedAt?: string
  createClient?: () => SupabaseClient | null
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`Invalid ${name}`)
  }
  return value
}

export class JobWorkerHeartbeat {
  private readonly workerId: string
  private readonly revision: string
  private readonly queues: string[]
  private readonly capacity: number
  private readonly draining: boolean
  private readonly intervalMs: number
  private readonly rpcTimeoutMs: number
  private readonly startedAt: string
  private readonly createClient: () => SupabaseClient | null
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>

  constructor(options: JobWorkerHeartbeatOptions) {
    const queues = [...new Set(options.queues)]
    if (!isJobIdentifier(options.workerId)
      || !/^(?:unknown|[0-9a-f]{7,64})$/.test(options.revision)
      || queues.length < 1 || queues.length > 32
      || queues.some(queue => !isJobName(queue, 64))
      || !Number.isFinite(Date.parse(options.startedAt ?? new Date().toISOString()))) {
      throw new TypeError('Invalid job worker heartbeat identity')
    }
    this.workerId = options.workerId
    this.revision = options.revision
    this.queues = queues
    this.capacity = boundedInteger(options.capacity, 1, 256, 'worker capacity')
    this.draining = options.draining === true
    this.intervalMs = boundedInteger(options.intervalMs ?? 5_000, 100, 60_000, 'heartbeat interval')
    this.rpcTimeoutMs = boundedInteger(options.rpcTimeoutMs ?? 3_000, 100, 10_000, 'heartbeat timeout')
    this.startedAt = options.startedAt ?? new Date().toISOString()
    this.createClient = options.createClient ?? createAdminClient
    this.sleep = options.sleep ?? defaultJobSleep
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.heartbeat(this.draining)
      } catch (error) {
        log.error('jobs', 'Worker heartbeat failed', {
          workerId: this.workerId,
          name: error instanceof Error ? error.name : 'unknown',
        })
      }
      try {
        await this.sleep(this.intervalMs, signal)
      } catch {
        break
      }
    }
    try {
      await this.markDraining()
    } catch (error) {
      log.warn('jobs', 'Worker draining heartbeat failed', {
        workerId: this.workerId,
        name: error instanceof Error ? error.name : 'unknown',
      })
    }
  }

  private client(): SupabaseClient {
    const client = this.createClient()
    if (!client) throw new Error('Worker heartbeat database is unavailable')
    return client
  }

  private async rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const request = this.client().rpc(name, args) as unknown as HeartbeatRpc
      const operation = typeof request.abortSignal === 'function'
        ? request.abortSignal(controller.signal)
        : request
      const response = await Promise.race([
        Promise.resolve(operation),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort()
            reject(new Error('Worker heartbeat timed out'))
          }, this.rpcTimeoutMs)
        }),
      ])
      if (response.error) throw new Error(`Worker heartbeat RPC failed: ${response.error.code ?? 'unknown'}`)
      return response.data
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private async heartbeat(draining: boolean): Promise<void> {
    const result = await this.rpc('heartbeat_job_worker', {
      input_worker_id: this.workerId,
      input_revision: this.revision,
      input_queues: this.queues,
      input_capacity: this.capacity,
      input_started_at: this.startedAt,
      input_draining: draining,
    })
    const value = Array.isArray(result) ? result[0] : result
    if (!value || typeof value !== 'object' || (value as { accepted?: unknown }).accepted !== true) {
      throw new Error('Worker heartbeat was rejected')
    }
  }

  private async markDraining(): Promise<void> {
    await this.rpc('mark_job_worker_draining', { input_worker_id: this.workerId })
  }
}
