import type { SupabaseClient } from '@/lib/supabase/types'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  REQUIRED_JOB_WORKER_QUEUES,
  type RequiredJobWorkerQueue,
} from '@/lib/jobs/worker-queues'
import { safeRevision } from '@/lib/supabase/health'

export const WORKER_FLEET_QUEUES = REQUIRED_JOB_WORKER_QUEUES
export type WorkerFleetQueue = RequiredJobWorkerQueue

const DEFAULT_RPC_TIMEOUT_MS = 3_000
const DEFAULT_MAX_AGE_SECONDS = 20

type WorkerQueueSample = {
  queue: WorkerFleetQueue
  ready: boolean
  activeWorkers: number
  totalCapacity: number
  freshestHeartbeatAgeSeconds: number | null
}

export type WorkerFleetMetricsV1 = {
  schemaVersion: 1
  generatedAt: string
  ready: boolean
  activeWorkers: number
  totalCapacity: number
  staleWorkers: number
  drainingWorkers: number
  freshestHeartbeatAgeSeconds: number | null
  oldestActiveHeartbeatAgeSeconds: number | null
  queues: WorkerQueueSample[]
}

type RpcResponse = { data: unknown; error: { code?: string } | null }
type RpcRequest = PromiseLike<RpcResponse> & {
  abortSignal?: (signal: AbortSignal) => PromiseLike<RpcResponse>
}

export type WorkerFleetMetricsDependencies = {
  createAdminClient: () => SupabaseClient | null
  rpcTimeoutMs: number
  maxAgeSeconds: number
  revision: string
}

const DEFAULT_DEPENDENCIES: WorkerFleetMetricsDependencies = {
  createAdminClient,
  rpcTimeoutMs: DEFAULT_RPC_TIMEOUT_MS,
  maxAgeSeconds: DEFAULT_MAX_AGE_SECONDS,
  revision: safeRevision(),
}

export class WorkerFleetMetricsUnavailable extends Error {
  constructor() {
    super('Authoritative worker fleet metrics are unavailable')
    this.name = 'WorkerFleetMetricsUnavailable'
  }
}

function malformed(): never {
  throw new WorkerFleetMetricsUnavailable()
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function countOf(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null
}

function secondsOf(value: unknown): number | null | undefined {
  if (value === null) return null
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined
}

function queuesOf(value: unknown): WorkerFleetQueue[] | null {
  if (!Array.isArray(value) || value.some(queue => typeof queue !== 'string')) return null
  const queues = value as string[]
  if (new Set(queues).size !== queues.length
    || queues.some(queue => !(WORKER_FLEET_QUEUES as readonly string[]).includes(queue))) return null
  return queues as WorkerFleetQueue[]
}

function parseQueueSample(value: unknown): WorkerQueueSample {
  const source = objectOf(value)
  const queue = source?.queue
  const activeWorkers = countOf(source?.activeWorkers)
  const totalCapacity = countOf(source?.totalCapacity)
  const age = secondsOf(source?.freshestHeartbeatAgeSeconds)
  if (typeof queue !== 'string'
    || !(WORKER_FLEET_QUEUES as readonly string[]).includes(queue)
    || typeof source?.ready !== 'boolean'
    || activeWorkers === null || totalCapacity === null || age === undefined
    || source.ready !== (activeWorkers > 0)
    || totalCapacity < activeWorkers
    || (source.ready && age === null)
    || (!source.ready && age !== null)) malformed()
  return {
    queue: queue as WorkerFleetQueue,
    ready: source.ready,
    activeWorkers,
    totalCapacity,
    freshestHeartbeatAgeSeconds: age,
  }
}

/** Rejects identifiers, unknown queues, and internally inconsistent fleet samples. */
export function parseWorkerFleetMetrics(value: unknown): WorkerFleetMetricsV1 {
  const source = objectOf(Array.isArray(value) ? value[0] : value)
  if (!source || source.schemaVersion !== 1 || typeof source.ready !== 'boolean'
    || typeof source.generatedAt !== 'string'
    || !Number.isFinite(Date.parse(source.generatedAt))) malformed()
  const activeWorkers = countOf(source.activeWorkers)
  const totalCapacity = countOf(source.totalCapacity)
  const staleWorkers = countOf(source.staleWorkers)
  const drainingWorkers = countOf(source.drainingWorkers)
  const freshestAge = secondsOf(source.freshestHeartbeatAgeSeconds)
  const oldestActiveAge = secondsOf(source.oldestActiveHeartbeatAgeSeconds)
  const required = queuesOf(source.requiredQueues)
  const covered = queuesOf(source.coveredQueues)
  const missing = queuesOf(source.missingQueues)
  if (activeWorkers === null || totalCapacity === null || staleWorkers === null
    || drainingWorkers === null || freshestAge === undefined || oldestActiveAge === undefined
    || !required || !covered || !missing
    || required.length !== WORKER_FLEET_QUEUES.length
    || WORKER_FLEET_QUEUES.some((queue, index) => required[index] !== queue)
    || covered.some(queue => missing.includes(queue))
    || WORKER_FLEET_QUEUES.some(queue => covered.includes(queue) === missing.includes(queue))
    || source.ready !== (missing.length === 0)
    || totalCapacity < activeWorkers
    || (activeWorkers === 0 && oldestActiveAge !== null)
    || (activeWorkers > 0 && oldestActiveAge === null)
    || !Array.isArray(source.queues)
    || source.queues.length !== WORKER_FLEET_QUEUES.length) malformed()

  const parsedQueues = source.queues.map(parseQueueSample)
  const samples = new Map(parsedQueues.map(queue => [queue.queue, queue]))
  if (samples.size !== WORKER_FLEET_QUEUES.length) malformed()
  const queues = WORKER_FLEET_QUEUES.map(queue => samples.get(queue) ?? malformed())
  for (const queue of queues) {
    if (queue.ready !== covered.includes(queue.queue)
      || queue.activeWorkers > activeWorkers
      || queue.totalCapacity > totalCapacity) malformed()
  }
  return {
    schemaVersion: 1,
    generatedAt: source.generatedAt,
    ready: source.ready,
    activeWorkers,
    totalCapacity,
    staleWorkers,
    drainingWorkers,
    freshestHeartbeatAgeSeconds: freshestAge,
    oldestActiveHeartbeatAgeSeconds: oldestActiveAge,
    queues,
  }
}

export async function readWorkerFleetMetrics(
  dependencies: Partial<WorkerFleetMetricsDependencies> = {},
): Promise<WorkerFleetMetricsV1> {
  const resolved = { ...DEFAULT_DEPENDENCIES, ...dependencies }
  if (!Number.isFinite(resolved.rpcTimeoutMs) || resolved.rpcTimeoutMs <= 0
    || !Number.isSafeInteger(resolved.maxAgeSeconds)
    || resolved.maxAgeSeconds < 5 || resolved.maxAgeSeconds > 300
    || !/^(?:unknown|[0-9a-f]{7,64})$/.test(resolved.revision)) malformed()
  let client: SupabaseClient | null
  try {
    client = resolved.createAdminClient()
  } catch {
    throw new WorkerFleetMetricsUnavailable()
  }
  if (!client) throw new WorkerFleetMetricsUnavailable()
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const raw = client.rpc('read_job_worker_readiness_v3', {
      input_required_queues: [...WORKER_FLEET_QUEUES],
      input_max_age_seconds: resolved.maxAgeSeconds,
      input_revision: resolved.revision,
    }) as unknown as RpcRequest
    const operation = typeof raw.abortSignal === 'function'
      ? raw.abortSignal(controller.signal)
      : raw
    const response = await Promise.race([
      Promise.resolve(operation),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort()
          reject(new WorkerFleetMetricsUnavailable())
        }, resolved.rpcTimeoutMs)
      }),
    ])
    if (response.error) throw new WorkerFleetMetricsUnavailable()
    return parseWorkerFleetMetrics(response.data)
  } catch (error) {
    if (error instanceof WorkerFleetMetricsUnavailable) throw error
    throw new WorkerFleetMetricsUnavailable()
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function header(name: string, help: string): string[] {
  return [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`]
}

function sample(name: string, value: number | null, labels = ''): string {
  return `${name}${labels} ${value === null ? 'NaN' : String(value)}`
}

export function exportWorkerFleetMetrics(
  metrics: WorkerFleetMetricsV1,
  now: number | Date = Date.now(),
): string {
  const nowMs = now instanceof Date ? now.getTime() : now
  const snapshotAge = Math.max(0, (nowMs - Date.parse(metrics.generatedAt)) / 1_000)
  const ageAtScrape = (age: number | null) => age === null ? null : age + snapshotAge
  const output: string[] = []
  const scalars: Array<[string, string, number | null]> = [
    ['snapshot_age_seconds', 'Age of the worker fleet database snapshot.', snapshotAge],
    ['ready', 'Whether fresh workers cover every required queue.', metrics.ready ? 1 : 0],
    ['active_workers', 'Fresh non-draining workers in the fleet.', metrics.activeWorkers],
    ['total_capacity', 'Declared capacity of fresh non-draining workers.', metrics.totalCapacity],
    ['stale_workers', 'Non-draining workers outside the heartbeat freshness bound.', metrics.staleWorkers],
    ['draining_workers', 'Workers that have entered drain mode.', metrics.drainingWorkers],
    ['freshest_heartbeat_age_seconds', 'Age of the freshest non-draining worker heartbeat.', ageAtScrape(metrics.freshestHeartbeatAgeSeconds)],
    ['oldest_active_heartbeat_age_seconds', 'Age of the oldest heartbeat still considered active.', ageAtScrape(metrics.oldestActiveHeartbeatAgeSeconds)],
  ]
  for (const [suffix, help, value] of scalars) {
    const name = `mychat_authoritative_worker_fleet_${suffix}`
    output.push(...header(name, help), sample(name, value))
  }

  const queueFamilies: Array<[
    string,
    string,
    (queue: WorkerQueueSample) => number | null,
  ]> = [
    ['ready', 'Whether a required queue has a fresh non-draining consumer.', queue => queue.ready ? 1 : 0],
    ['active_workers', 'Fresh non-draining workers that cover a required queue.', queue => queue.activeWorkers],
    ['total_capacity', 'Declared capacity covering a required queue.', queue => queue.totalCapacity],
    ['freshest_heartbeat_age_seconds', 'Age of the freshest heartbeat covering a required queue.', queue => ageAtScrape(queue.freshestHeartbeatAgeSeconds)],
  ]
  for (const [suffix, help, valueOf] of queueFamilies) {
    const name = `mychat_authoritative_worker_queue_${suffix}`
    output.push(...header(name, help))
    for (const queue of metrics.queues) {
      output.push(sample(name, valueOf(queue), `{queue="${queue.queue}"}`))
    }
  }
  return `${output.join('\n')}\n`
}
