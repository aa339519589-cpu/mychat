export const JOB_METRIC_TYPES = [
  'chat_generation',
  'media_image',
  'media_video',
  'agent_task',
  'tool',
  'title',
  'cleanup',
  'other',
] as const

export const JOB_CLAIM_OUTCOMES = [
  'claimed',
  'contended',
  'unavailable',
  'invalid',
] as const

export const JOB_TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'] as const

export const PROVIDER_CATEGORIES = [
  'llm',
  'image',
  'video',
  'search',
  'sandbox',
  'storage',
  'github',
  'database',
  'other',
] as const

export type JobMetricType = typeof JOB_METRIC_TYPES[number]
export type JobClaimOutcome = typeof JOB_CLAIM_OUTCOMES[number]
export type JobTerminalStatus = typeof JOB_TERMINAL_STATUSES[number]
export type ProviderCategory = typeof PROVIDER_CATEGORIES[number]

type CounterSample<Labels> = Labels & { value: number }
type HistogramBucket = { le: number | '+Inf'; count: number }
type HistogramSample<Labels> = Labels & {
  count: number
  sum_seconds: number
  buckets: HistogramBucket[]
}

export type JobMetricsSnapshotV1 = {
  schema_version: '1'
  generated_at: string
  counters: {
    jobs_enqueued_total: Array<CounterSample<{ job_type: JobMetricType }>>
    job_claims_total: Array<CounterSample<{ job_type: JobMetricType; outcome: JobClaimOutcome }>>
    job_lease_expirations_total: Array<CounterSample<{ job_type: JobMetricType }>>
    jobs_terminal_total: Array<CounterSample<{ job_type: JobMetricType; status: JobTerminalStatus }>>
    provider_errors_total: Array<CounterSample<{
      job_type: JobMetricType
      provider_category: ProviderCategory
      retryable: 'true' | 'false'
    }>>
  }
  gauges: {
    queue_depth: Array<{ job_type: JobMetricType; value: number }>
    queue_oldest_age_seconds: Array<{ job_type: JobMetricType; value: number }>
  }
  histograms: {
    job_queue_latency_seconds: Array<HistogramSample<{ job_type: JobMetricType }>>
    job_run_duration_seconds: Array<HistogramSample<{
      job_type: JobMetricType
      status: JobTerminalStatus
    }>>
  }
}

type HistogramState = {
  count: number
  sum: number
  bucketCounts: number[]
}

const QUEUE_LATENCY_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300] as const
const RUN_DURATION_BUCKETS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600, 1_800] as const
const KEY_SEPARATOR = '\u0000'

function key(...parts: string[]): string {
  return parts.join(KEY_SEPARATOR)
}

function parts(value: string): string[] {
  return value.split(KEY_SEPARATOR)
}

function assertAllowed<T extends string>(
  value: string,
  allowed: readonly T[],
  label: string,
): asserts value is T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new TypeError(`${label} is not an allowed bounded metric label`)
  }
}

function assertNonNegative(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${field} must be a finite non-negative number`)
  }
}

function increment(map: Map<string, number>, sampleKey: string): void {
  map.set(sampleKey, (map.get(sampleKey) ?? 0) + 1)
}

function observe(
  map: Map<string, HistogramState>,
  sampleKey: string,
  seconds: number,
  buckets: readonly number[],
): void {
  const state = map.get(sampleKey) ?? {
    count: 0,
    sum: 0,
    bucketCounts: buckets.map(() => 0),
  }
  state.count += 1
  state.sum += seconds
  for (let index = 0; index < buckets.length; index += 1) {
    if (seconds <= buckets[index]!) state.bucketCounts[index] += 1
  }
  map.set(sampleKey, state)
}

function histogramBuckets(state: HistogramState, bounds: readonly number[]): HistogramBucket[] {
  return [
    ...bounds.map((le, index) => ({ le, count: state.bucketCounts[index] ?? 0 })),
    { le: '+Inf' as const, count: state.count },
  ]
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(15)))
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')
}

function labels(values: Readonly<Record<string, string>>): string {
  const entries = Object.entries(values)
  if (entries.length === 0) return ''
  return `{${entries.map(([name, value]) => `${name}="${escapeLabel(value)}"`).join(',')}}`
}

function metricHeader(name: string, help: string, type: 'counter' | 'gauge' | 'histogram'): string[] {
  return [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`]
}

/**
 * In-process metrics for job control-plane code. Every label is a closed enum;
 * principal ids, job ids, URLs, and provider names are deliberately impossible
 * to attach, keeping memory and exporter cardinality bounded.
 */
export class JobMetrics {
  private readonly enqueued = new Map<string, number>()
  private readonly claims = new Map<string, number>()
  private readonly leaseExpirations = new Map<string, number>()
  private readonly terminals = new Map<string, number>()
  private readonly providerErrors = new Map<string, number>()
  private readonly queueDepth = new Map<string, number>()
  private readonly queueOldestAge = new Map<string, number>()
  private readonly queueLatency = new Map<string, HistogramState>()
  private readonly runDuration = new Map<string, HistogramState>()

  recordEnqueued(jobType: JobMetricType): void {
    assertAllowed(jobType, JOB_METRIC_TYPES, 'job_type')
    increment(this.enqueued, jobType)
  }

  recordClaim(jobType: JobMetricType, outcome: JobClaimOutcome): void {
    assertAllowed(jobType, JOB_METRIC_TYPES, 'job_type')
    assertAllowed(outcome, JOB_CLAIM_OUTCOMES, 'outcome')
    increment(this.claims, key(jobType, outcome))
  }

  recordLeaseExpiration(jobType: JobMetricType): void {
    assertAllowed(jobType, JOB_METRIC_TYPES, 'job_type')
    increment(this.leaseExpirations, jobType)
  }

  recordTerminal(jobType: JobMetricType, status: JobTerminalStatus): void {
    assertAllowed(jobType, JOB_METRIC_TYPES, 'job_type')
    assertAllowed(status, JOB_TERMINAL_STATUSES, 'status')
    increment(this.terminals, key(jobType, status))
  }

  recordProviderError(
    jobType: JobMetricType,
    providerCategory: ProviderCategory,
    retryable: boolean,
  ): void {
    assertAllowed(jobType, JOB_METRIC_TYPES, 'job_type')
    assertAllowed(providerCategory, PROVIDER_CATEGORIES, 'provider_category')
    increment(this.providerErrors, key(jobType, providerCategory, String(retryable)))
  }

  setQueueState(jobType: JobMetricType, depth: number, oldestAgeMs: number): void {
    assertAllowed(jobType, JOB_METRIC_TYPES, 'job_type')
    assertNonNegative(depth, 'depth')
    assertNonNegative(oldestAgeMs, 'oldestAgeMs')
    if (!Number.isSafeInteger(depth)) throw new RangeError('depth must be a safe integer')
    this.queueDepth.set(jobType, depth)
    this.queueOldestAge.set(jobType, oldestAgeMs / 1_000)
  }

  observeQueueLatency(jobType: JobMetricType, durationMs: number): void {
    assertAllowed(jobType, JOB_METRIC_TYPES, 'job_type')
    assertNonNegative(durationMs, 'durationMs')
    observe(this.queueLatency, jobType, durationMs / 1_000, QUEUE_LATENCY_BUCKETS)
  }

  observeRunDuration(
    jobType: JobMetricType,
    status: JobTerminalStatus,
    durationMs: number,
  ): void {
    assertAllowed(jobType, JOB_METRIC_TYPES, 'job_type')
    assertAllowed(status, JOB_TERMINAL_STATUSES, 'status')
    assertNonNegative(durationMs, 'durationMs')
    observe(this.runDuration, key(jobType, status), durationMs / 1_000, RUN_DURATION_BUCKETS)
  }

  snapshot(now: number | Date = Date.now()): JobMetricsSnapshotV1 {
    const generatedAt = now instanceof Date ? now : new Date(now)
    return {
      schema_version: '1',
      generated_at: generatedAt.toISOString(),
      counters: {
        jobs_enqueued_total: [...this.enqueued.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([job_type, value]) => ({ job_type: job_type as JobMetricType, value })),
        job_claims_total: [...this.claims.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([sampleKey, value]) => {
            const [job_type, outcome] = parts(sampleKey)
            return { job_type: job_type as JobMetricType, outcome: outcome as JobClaimOutcome, value }
          }),
        job_lease_expirations_total: [...this.leaseExpirations.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([job_type, value]) => ({ job_type: job_type as JobMetricType, value })),
        jobs_terminal_total: [...this.terminals.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([sampleKey, value]) => {
            const [job_type, status] = parts(sampleKey)
            return { job_type: job_type as JobMetricType, status: status as JobTerminalStatus, value }
          }),
        provider_errors_total: [...this.providerErrors.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([sampleKey, value]) => {
            const [job_type, provider_category, retryable] = parts(sampleKey)
            return {
              job_type: job_type as JobMetricType,
              provider_category: provider_category as ProviderCategory,
              retryable: retryable as 'true' | 'false',
              value,
            }
          }),
      },
      gauges: {
        queue_depth: [...this.queueDepth.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([job_type, value]) => ({ job_type: job_type as JobMetricType, value })),
        queue_oldest_age_seconds: [...this.queueOldestAge.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([job_type, value]) => ({ job_type: job_type as JobMetricType, value })),
      },
      histograms: {
        job_queue_latency_seconds: [...this.queueLatency.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([job_type, state]) => ({
            job_type: job_type as JobMetricType,
            count: state.count,
            sum_seconds: state.sum,
            buckets: histogramBuckets(state, QUEUE_LATENCY_BUCKETS),
          })),
        job_run_duration_seconds: [...this.runDuration.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([sampleKey, state]) => {
            const [job_type, status] = parts(sampleKey)
            return {
              job_type: job_type as JobMetricType,
              status: status as JobTerminalStatus,
              count: state.count,
              sum_seconds: state.sum,
              buckets: histogramBuckets(state, RUN_DURATION_BUCKETS),
            }
          }),
      },
    }
  }

  exportPrometheus(): string {
    const snapshot = this.snapshot()
    const output: string[] = []

    const counter = <T extends Readonly<Record<string, string | number>>>(
      name: string,
      help: string,
      samples: readonly T[],
      labelNames: readonly (keyof T)[],
    ) => {
      output.push(...metricHeader(name, help, 'counter'))
      for (const sample of samples) {
        const metricLabels: Record<string, string> = {}
        for (const labelName of labelNames) metricLabels[String(labelName)] = String(sample[labelName])
        output.push(`${name}${labels(metricLabels)} ${formatNumber(Number(sample.value))}`)
      }
    }

    const gauge = <T extends Readonly<Record<string, string | number>>>(
      name: string,
      help: string,
      samples: readonly T[],
      labelNames: readonly (keyof T)[],
    ) => {
      output.push(...metricHeader(name, help, 'gauge'))
      for (const sample of samples) {
        const metricLabels: Record<string, string> = {}
        for (const labelName of labelNames) metricLabels[String(labelName)] = String(sample[labelName])
        output.push(`${name}${labels(metricLabels)} ${formatNumber(Number(sample.value))}`)
      }
    }

    counter('mychat_jobs_enqueued_total', 'Jobs accepted into a durable queue.', snapshot.counters.jobs_enqueued_total, ['job_type'])
    counter('mychat_job_claims_total', 'Worker claim attempts by bounded outcome.', snapshot.counters.job_claims_total, ['job_type', 'outcome'])
    counter('mychat_job_lease_expirations_total', 'Expired job leases observed.', snapshot.counters.job_lease_expirations_total, ['job_type'])
    counter('mychat_jobs_terminal_total', 'Authoritative job terminal transitions.', snapshot.counters.jobs_terminal_total, ['job_type', 'status'])
    counter('mychat_provider_errors_total', 'Upstream errors grouped by provider category.', snapshot.counters.provider_errors_total, ['job_type', 'provider_category', 'retryable'])
    gauge('mychat_queue_depth', 'Current queued jobs by bounded job type.', snapshot.gauges.queue_depth, ['job_type'])
    gauge('mychat_queue_oldest_age_seconds', 'Age of the oldest queued job.', snapshot.gauges.queue_oldest_age_seconds, ['job_type'])

    const histogram = <T extends {
      count: number
      sum_seconds: number
      buckets: HistogramBucket[]
    } & Readonly<Record<string, unknown>>>(
      name: string,
      help: string,
      samples: readonly T[],
      labelNames: readonly (keyof T)[],
    ) => {
      output.push(...metricHeader(name, help, 'histogram'))
      for (const sample of samples) {
        const metricLabels: Record<string, string> = {}
        for (const labelName of labelNames) metricLabels[String(labelName)] = String(sample[labelName])
        for (const bucket of sample.buckets) {
          output.push(`${name}_bucket${labels({ ...metricLabels, le: String(bucket.le) })} ${bucket.count}`)
        }
        output.push(`${name}_sum${labels(metricLabels)} ${formatNumber(sample.sum_seconds)}`)
        output.push(`${name}_count${labels(metricLabels)} ${sample.count}`)
      }
    }

    histogram('mychat_job_queue_latency_seconds', 'Time from enqueue to a successful claim.', snapshot.histograms.job_queue_latency_seconds, ['job_type'])
    histogram('mychat_job_run_duration_seconds', 'Time from claim to authoritative terminal state.', snapshot.histograms.job_run_duration_seconds, ['job_type', 'status'])

    return `${output.join('\n')}\n`
  }

  reset(): void {
    this.enqueued.clear()
    this.claims.clear()
    this.leaseExpirations.clear()
    this.terminals.clear()
    this.providerErrors.clear()
    this.queueDepth.clear()
    this.queueOldestAge.clear()
    this.queueLatency.clear()
    this.runDuration.clear()
  }
}

const globalMetrics = globalThis as typeof globalThis & {
  __mychatJobMetrics?: JobMetrics
}

/** Process-local registry; scrape/ship each process and aggregate externally. */
export const jobMetrics = globalMetrics.__mychatJobMetrics ?? new JobMetrics()
globalMetrics.__mychatJobMetrics = jobMetrics

export function exportJobMetrics(): string {
  return jobMetrics.exportPrometheus()
}
