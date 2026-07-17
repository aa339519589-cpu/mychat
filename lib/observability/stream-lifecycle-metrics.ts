import type { SupabaseClient } from '@/lib/supabase/types'
import { createAdminClient } from '@/lib/supabase/admin'

const RPC_TIMEOUT_MS = 3_000

export type StreamLifecycleMetricsV1 = {
  schemaVersion: 1
  generatedAt: string
  activeStreams: number
  streamCapacity: number
  expiredStreamLeases: number
  expiredAdmissionReservations: number
  retainedPayloads: number
  overduePayloads: number
  payloadCleanupDeadLetters: number
  outboxGcEligible: number
  tenantsNearResourceLimit: number
}

type Dependencies = {
  createAdminClient: () => SupabaseClient | null
  rpcTimeoutMs: number
}
type RpcResponse = { data: unknown; error: unknown }
type RpcRequest = PromiseLike<RpcResponse> & {
  abortSignal?: (signal: AbortSignal) => PromiseLike<RpcResponse>
}

export class StreamLifecycleMetricsUnavailable extends Error {
  constructor() {
    super('Stream lifecycle metrics are unavailable')
    this.name = 'StreamLifecycleMetricsUnavailable'
  }
}

function count(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null
}

export function parseStreamLifecycleMetrics(value: unknown): StreamLifecycleMetricsV1 {
  const normalized = Array.isArray(value) ? value[0] : value
  const row = normalized !== null && typeof normalized === 'object' && !Array.isArray(normalized)
    ? normalized as Record<string, unknown>
    : null
  const fields = row ? {
    activeStreams: count(row.activeStreams),
    streamCapacity: count(row.streamCapacity),
    expiredStreamLeases: count(row.expiredStreamLeases),
    expiredAdmissionReservations: count(row.expiredAdmissionReservations),
    retainedPayloads: count(row.retainedPayloads),
    overduePayloads: count(row.overduePayloads),
    payloadCleanupDeadLetters: count(row.payloadCleanupDeadLetters),
    outboxGcEligible: count(row.outboxGcEligible),
    tenantsNearResourceLimit: count(row.tenantsNearResourceLimit),
  } : null
  if (!row || row.schemaVersion !== 1 || typeof row.generatedAt !== 'string'
    || !Number.isFinite(Date.parse(row.generatedAt)) || !fields
    || ['principalId', 'jobId', 'objectKey'].some(key => key in row)
    || Object.values(fields).some(item => item === null)
    || fields.streamCapacity !== 256
    || Number(fields.activeStreams) > Number(fields.streamCapacity)
    || Number(fields.overduePayloads) > Number(fields.retainedPayloads)) {
    throw new StreamLifecycleMetricsUnavailable()
  }
  return {
    schemaVersion: 1,
    generatedAt: row.generatedAt,
    activeStreams: Number(fields.activeStreams),
    streamCapacity: Number(fields.streamCapacity),
    expiredStreamLeases: Number(fields.expiredStreamLeases),
    expiredAdmissionReservations: Number(fields.expiredAdmissionReservations),
    retainedPayloads: Number(fields.retainedPayloads),
    overduePayloads: Number(fields.overduePayloads),
    payloadCleanupDeadLetters: Number(fields.payloadCleanupDeadLetters),
    outboxGcEligible: Number(fields.outboxGcEligible),
    tenantsNearResourceLimit: Number(fields.tenantsNearResourceLimit),
  }
}

export async function readStreamLifecycleMetrics(
  dependencyOverrides: Partial<Dependencies> = {},
): Promise<StreamLifecycleMetricsV1> {
  const dependencies: Dependencies = {
    createAdminClient,
    rpcTimeoutMs: RPC_TIMEOUT_MS,
    ...dependencyOverrides,
  }
  const client = dependencies.createAdminClient()
  if (!client || !Number.isFinite(dependencies.rpcTimeoutMs) || dependencies.rpcTimeoutMs <= 0) {
    throw new StreamLifecycleMetricsUnavailable()
  }
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const raw = client.rpc('read_stream_lifecycle_metrics_v1') as unknown as RpcRequest
    const operation = typeof raw.abortSignal === 'function'
      ? raw.abortSignal(controller.signal)
      : raw
    const response = await Promise.race([
      Promise.resolve(operation),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort()
          reject(new StreamLifecycleMetricsUnavailable())
        }, dependencies.rpcTimeoutMs)
      }),
    ])
    if (response.error) throw new StreamLifecycleMetricsUnavailable()
    return parseStreamLifecycleMetrics(response.data)
  } catch (error) {
    if (error instanceof StreamLifecycleMetricsUnavailable) throw error
    throw new StreamLifecycleMetricsUnavailable()
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export function exportStreamLifecycleMetrics(
  metrics: StreamLifecycleMetricsV1,
  now: number | Date = Date.now(),
): string {
  const nowMs = now instanceof Date ? now.getTime() : now
  const values: Array<[string, string, number]> = [
    ['snapshot_age_seconds', 'Age of the stream lifecycle database snapshot.', Math.max(0, (nowMs - Date.parse(metrics.generatedAt)) / 1_000)],
    ['active_streams', 'Active admitted Job event streams.', metrics.activeStreams],
    ['stream_capacity', 'Global admitted Job event stream capacity.', metrics.streamCapacity],
    ['expired_stream_leases', 'Expired stream leases awaiting collection.', metrics.expiredStreamLeases],
    ['expired_admission_reservations', 'Expired admission holds awaiting safe reclamation.', metrics.expiredAdmissionReservations],
    ['retained_payloads', 'Terminal Job payloads retained for cleanup.', metrics.retainedPayloads],
    ['overdue_payloads', 'Job payloads overdue by more than five minutes.', metrics.overduePayloads],
    ['payload_cleanup_dead_letters', 'Dead-lettered payload cleanup deliveries.', metrics.payloadCleanupDeadLetters],
    ['outbox_gc_eligible', 'Published outbox rows eligible for garbage collection.', metrics.outboxGcEligible],
    ['tenants_near_resource_limit', 'Tenants at or above ninety percent of a resource limit.', metrics.tenantsNearResourceLimit],
  ]
  return `${values.flatMap(([suffix, help, value]) => {
    const name = `mychat_authoritative_lifecycle_${suffix}`
    return [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${value}`]
  }).join('\n')}\n`
}
