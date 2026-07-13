import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  JOB_METRIC_TYPES,
  JOB_TERMINAL_STATUSES,
  type JobMetricType,
  type JobTerminalStatus,
} from './job-metrics'

const DEFAULT_WINDOW_SECONDS = 3_600
const DEFAULT_RPC_TIMEOUT_MS = 8_000

type SloSample = {
  good: number
  eligible: number
  ratio: number | null
}

type JobTypeSample = {
  jobType: JobMetricType
  queueDepth: number
  queueOldestAgeSeconds: number
  terminal: Record<JobTerminalStatus, number>
  terminalTotal: Record<JobTerminalStatus, number>
  leaseExpired: number
  retryWaiting: number
  poison: number
  enqueueStarted: SloSample
  cancelTerminal: SloSample
}

export type AuthoritativeJobMetricsV1 = {
  schemaVersion: 1
  generatedAt: string
  windowSeconds: number
  jobTypes: JobTypeSample[]
  outbox: {
    pending: number
    ready: number
    oldestReadyAgeSeconds: number
    expiredLeases: number
    retrying: number
    dead: number
  }
  assets: {
    cleanupPending: number
    cleanupDead: number
    cleanupOrphan: number
  }
}

type RpcResponse = { data: unknown; error: { code?: string } | null }
type RpcRequest = PromiseLike<RpcResponse> & {
  abortSignal?: (signal: AbortSignal) => PromiseLike<RpcResponse>
}

export type AuthoritativeJobMetricsDependencies = {
  createAdminClient: () => SupabaseClient | null
  rpcTimeoutMs: number
  windowSeconds: number
}

const DEFAULT_DEPENDENCIES: AuthoritativeJobMetricsDependencies = {
  createAdminClient,
  rpcTimeoutMs: DEFAULT_RPC_TIMEOUT_MS,
  windowSeconds: DEFAULT_WINDOW_SECONDS,
}

export class AuthoritativeJobMetricsUnavailable extends Error {
  constructor() {
    super('Authoritative job metrics are unavailable')
    this.name = 'AuthoritativeJobMetricsUnavailable'
  }
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function countOf(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null
}

function secondsOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function ratioOf(value: unknown): number | null | undefined {
  if (value === null) return null
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined
}

function malformed(): never {
  throw new AuthoritativeJobMetricsUnavailable()
}

function parseSlo(value: unknown): SloSample {
  const source = objectOf(value)
  const good = countOf(source?.good)
  const eligible = countOf(source?.eligible)
  const ratio = ratioOf(source?.ratio)
  if (good === null || eligible === null || ratio === undefined || good > eligible
    || (eligible === 0 && ratio !== null) || (eligible > 0 && ratio === null)) malformed()
  return { good, eligible, ratio }
}

function parseJobType(value: unknown): JobTypeSample {
  const source = objectOf(value)
  if (!source) malformed()
  const jobType = source.jobType
  if (typeof jobType !== 'string'
    || !(JOB_METRIC_TYPES as readonly string[]).includes(jobType)) malformed()
  const queueDepth = countOf(source.queueDepth)
  const queueOldestAgeSeconds = secondsOf(source.queueOldestAgeSeconds)
  const terminalSource = objectOf(source.terminal)
  const terminalTotalSource = objectOf(source.terminalTotal)
  const completed = countOf(terminalSource?.completed)
  const failed = countOf(terminalSource?.failed)
  const cancelled = countOf(terminalSource?.cancelled)
  const totalCompleted = countOf(terminalTotalSource?.completed)
  const totalFailed = countOf(terminalTotalSource?.failed)
  const totalCancelled = countOf(terminalTotalSource?.cancelled)
  const leaseExpired = countOf(source.leaseExpired)
  const retryWaiting = countOf(source.retryWaiting)
  const poison = countOf(source.poison)
  if (queueDepth === null || queueOldestAgeSeconds === null || completed === null
    || failed === null || cancelled === null || totalCompleted === null
    || totalFailed === null || totalCancelled === null || leaseExpired === null
    || retryWaiting === null || poison === null) malformed()
  return {
    jobType: jobType as JobMetricType,
    queueDepth,
    queueOldestAgeSeconds,
    terminal: { completed, failed, cancelled },
    terminalTotal: {
      completed: totalCompleted,
      failed: totalFailed,
      cancelled: totalCancelled,
    },
    leaseExpired,
    retryWaiting,
    poison,
    enqueueStarted: parseSlo(source.enqueueStarted),
    cancelTerminal: parseSlo(source.cancelTerminal),
  }
}

function parseAggregate<T extends Record<string, number>>(
  value: unknown,
  fields: readonly (keyof T)[],
): T {
  const source = objectOf(value)
  if (!source) malformed()
  const parsed: Partial<T> = {}
  for (const field of fields) {
    const count = field.toString().toLowerCase().includes('seconds')
      ? secondsOf(source[String(field)])
      : countOf(source[String(field)])
    if (count === null) malformed()
    parsed[field] = count as T[keyof T]
  }
  return parsed as T
}

/** Rejects malformed/high-cardinality database responses before Prometheus rendering. */
export function parseAuthoritativeJobMetrics(value: unknown): AuthoritativeJobMetricsV1 {
  const source = objectOf(Array.isArray(value) ? value[0] : value)
  if (!source) malformed()
  const windowSeconds = countOf(source.windowSeconds)
  const generatedAt = source.generatedAt
  if (source.schemaVersion !== 1 || windowSeconds === null
    || windowSeconds < 300 || windowSeconds > 86_400
    || typeof generatedAt !== 'string' || !Number.isFinite(Date.parse(generatedAt))) malformed()
  if (!Array.isArray(source.jobTypes) || source.jobTypes.length !== JOB_METRIC_TYPES.length) malformed()
  const parsedJobTypes = source.jobTypes.map(parseJobType)
  const samples = new Map(parsedJobTypes.map(sample => [sample.jobType, sample]))
  if (samples.size !== JOB_METRIC_TYPES.length
    || JOB_METRIC_TYPES.some(jobType => !samples.has(jobType))) malformed()
  return {
    schemaVersion: 1,
    generatedAt,
    windowSeconds,
    jobTypes: JOB_METRIC_TYPES.map(jobType => samples.get(jobType)!),
    outbox: parseAggregate<AuthoritativeJobMetricsV1['outbox']>(source.outbox, [
      'pending', 'ready', 'oldestReadyAgeSeconds', 'expiredLeases', 'retrying', 'dead',
    ]),
    assets: parseAggregate<AuthoritativeJobMetricsV1['assets']>(source.assets, [
      'cleanupPending', 'cleanupDead', 'cleanupOrphan',
    ]),
  }
}

export async function readAuthoritativeJobMetrics(
  dependencies: Partial<AuthoritativeJobMetricsDependencies> = {},
): Promise<AuthoritativeJobMetricsV1> {
  const resolved = { ...DEFAULT_DEPENDENCIES, ...dependencies }
  if (!Number.isSafeInteger(resolved.windowSeconds)
    || resolved.windowSeconds < 300 || resolved.windowSeconds > 86_400
    || !Number.isFinite(resolved.rpcTimeoutMs) || resolved.rpcTimeoutMs <= 0) malformed()
  let client: SupabaseClient | null
  try {
    client = resolved.createAdminClient()
  } catch {
    throw new AuthoritativeJobMetricsUnavailable()
  }
  if (!client) throw new AuthoritativeJobMetricsUnavailable()
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const raw = client.rpc('read_job_observability_v1', {
      input_window_seconds: resolved.windowSeconds,
    }) as unknown as RpcRequest
    const operation = typeof raw.abortSignal === 'function'
      ? raw.abortSignal(controller.signal)
      : raw
    const response = await Promise.race([
      Promise.resolve(operation),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort()
          reject(new AuthoritativeJobMetricsUnavailable())
        }, resolved.rpcTimeoutMs)
      }),
    ])
    if (response.error) throw new AuthoritativeJobMetricsUnavailable()
    return parseAuthoritativeJobMetrics(response.data)
  } catch (error) {
    if (error instanceof AuthoritativeJobMetricsUnavailable) throw error
    throw new AuthoritativeJobMetricsUnavailable()
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function header(name: string, help: string, type: 'gauge' | 'counter' = 'gauge'): string[] {
  return [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`]
}

function sample(name: string, value: number | null, labels = ''): string {
  return `${name}${labels} ${value === null ? 'NaN' : String(value)}`
}

function jobLabel(jobType: JobMetricType): string {
  return `{job_type="${jobType}"}`
}

/** Renders only recomputed gauges; process-local monotonic counters are appended by the route. */
export function exportAuthoritativeJobMetrics(
  metrics: AuthoritativeJobMetricsV1,
  now: number | Date = Date.now(),
): string {
  const nowMs = now instanceof Date ? now.getTime() : now
  const output: string[] = []
  output.push(...header('mychat_authoritative_snapshot_age_seconds', 'Age of the database metrics snapshot.'))
  output.push(sample('mychat_authoritative_snapshot_age_seconds', Math.max(0, (nowMs - Date.parse(metrics.generatedAt)) / 1_000)))
  output.push(...header('mychat_authoritative_window_seconds', 'Observation window used for terminal and SLO gauges.'))
  output.push(sample('mychat_authoritative_window_seconds', metrics.windowSeconds))

  const families = [
    ['queue_depth', 'Current durable queued jobs.', (value: JobTypeSample) => value.queueDepth],
    ['queue_oldest_age_seconds', 'Age of the oldest durable queued job.', (value: JobTypeSample) => value.queueOldestAgeSeconds],
    ['job_lease_expired', 'Active jobs whose database lease has expired.', (value: JobTypeSample) => value.leaseExpired],
    ['job_retry_waiting', 'Queued jobs that have already attempted execution.', (value: JobTypeSample) => value.retryWaiting],
    ['job_poison_window', 'Poisoned terminal jobs in the observation window.', (value: JobTypeSample) => value.poison],
  ] as const
  for (const [suffix, help, valueOf] of families) {
    const name = `mychat_authoritative_${suffix}`
    output.push(...header(name, help))
    for (const value of metrics.jobTypes) output.push(sample(name, valueOf(value), jobLabel(value.jobType)))
  }

  const terminalName = 'mychat_authoritative_jobs_terminal_window'
  output.push(...header(terminalName, 'Authoritative terminal transitions in the observation window.'))
  for (const value of metrics.jobTypes) {
    for (const status of JOB_TERMINAL_STATUSES) {
      output.push(sample(terminalName, value.terminal[status], `{job_type="${value.jobType}",status="${status}"}`))
    }
  }
  const terminalTotalName = 'mychat_authoritative_jobs_terminal_total'
  output.push(...header(
    terminalTotalName,
    'Database-authoritative terminal transitions since control-plane inception.',
    'counter',
  ))
  for (const value of metrics.jobTypes) {
    for (const status of JOB_TERMINAL_STATUSES) {
      output.push(sample(
        terminalTotalName,
        value.terminalTotal[status],
        `{job_type="${value.jobType}",status="${status}"}`,
      ))
    }
  }

  const scalarFamilies: Array<[string, string, number]> = [
    ['outbox_pending', 'Undelivered outbox messages.', metrics.outbox.pending],
    ['outbox_ready', 'Currently claimable outbox messages.', metrics.outbox.ready],
    ['outbox_oldest_ready_age_seconds', 'Age of the oldest claimable outbox message.', metrics.outbox.oldestReadyAgeSeconds],
    ['outbox_expired_leases', 'Outbox delivery leases that have expired.', metrics.outbox.expiredLeases],
    ['outbox_retrying', 'Undelivered outbox messages with prior attempts.', metrics.outbox.retrying],
    ['outbox_dead', 'Dead-lettered outbox messages.', metrics.outbox.dead],
  ]
  for (const [suffix, help, value] of scalarFamilies) {
    const name = `mychat_authoritative_${suffix}`
    output.push(...header(name, help), sample(name, value))
  }

  const cleanupName = 'mychat_authoritative_asset_cleanup'
  output.push(...header(cleanupName, 'Generated-media cleanup convergence by bounded condition.'))
  output.push(sample(cleanupName, metrics.assets.cleanupPending, '{condition="pending"}'))
  output.push(sample(cleanupName, metrics.assets.cleanupDead, '{condition="dead"}'))
  output.push(sample(cleanupName, metrics.assets.cleanupOrphan, '{condition="orphan"}'))

  const objectives = [
    ['enqueue_started_2s', (value: JobTypeSample) => value.enqueueStarted],
    ['cancel_terminal_3s', (value: JobTypeSample) => value.cancelTerminal],
  ] as const
  for (const measure of ['good', 'eligible', 'ratio'] as const) {
    const name = `mychat_authoritative_slo_window_${measure}`
    output.push(...header(name, `SLO window ${measure} observations.`))
    for (const [objective, valueOf] of objectives) {
      for (const value of metrics.jobTypes) {
        output.push(sample(
          name,
          valueOf(value)[measure],
          `{objective="${objective}",job_type="${value.jobType}"}`,
        ))
      }
    }
  }
  return `${output.join('\n')}\n`
}
