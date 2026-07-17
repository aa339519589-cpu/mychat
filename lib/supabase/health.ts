import { createAdminClient, isAdminConfigured } from './admin'
import {
  isolatedSandboxConfigured,
  productionAgentSandboxReady,
} from '@/lib/agent/execution-policy'
import { REQUIRED_JOB_WORKER_QUEUES } from '@/lib/jobs/worker-queues'
import { jobMaintenanceMode } from '@/lib/jobs/maintenance'
import { streamAdmissionHashKey } from '@/lib/jobs/stream-admission'
import { metricsBearerToken } from '@/lib/observability/metrics-auth'
import { MIGRATION_CONTRACT } from '@/lib/supabase/migration-contract'

type HealthEnvironment = {
  [key: string]: string | undefined
  NODE_ENV?: string
  NEXT_PUBLIC_SUPABASE_URL?: string
  NEXT_PUBLIC_SUPABASE_ANON_KEY?: string
  SUPABASE_URL?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
  E2B_API_KEY?: string
  RENDER_GIT_COMMIT?: string
  VERCEL_GIT_COMMIT_SHA?: string
  MYCHAT_BUILD_REVISION?: string
  METRICS_BEARER_TOKEN?: string
  MYCHAT_MAINTENANCE_MODE?: string
  GENERATION_MAINTENANCE_MODE?: string
}

type HealthRpcResponse = { data: unknown; error: unknown }
type HealthRpcRequest = PromiseLike<HealthRpcResponse> & {
  abortSignal?: (signal: AbortSignal) => PromiseLike<HealthRpcResponse>
}
type HealthRpcClient = {
  rpc: (name: string, args?: Record<string, unknown>) => HealthRpcRequest
}

export type RuntimeHealth = {
  ready: boolean
  revision: string
  checks: {
    auth: { configured: boolean; ready: boolean }
    database: { configured: boolean; ready: boolean }
    distributedRateLimit: { configured: boolean; ready: boolean }
    queue: { configured: boolean; ready: boolean }
    worker: { configured: boolean; ready: boolean; draining: boolean }
    stream: { configured: boolean; ready: boolean }
    observability: { configured: boolean; ready: boolean }
    sandbox: { configured: boolean; ready: boolean }
  }
}

export type RuntimeLiveness = {
  live: true
  revision: string
}

export type QueueReadinessProbe = {
  configured: boolean
  check: () => boolean | PromiseLike<boolean>
}

export type RuntimeHealthOptions = {
  /** Optional adapter for a queue that is not covered by the database contract. */
  queue?: QueueReadinessProbe
  timeoutMs?: number
}

const RUNTIME_HEALTHCHECK_RPC = 'verify_schema_contract_v1'
const WORKER_READINESS_RPC = 'read_job_worker_readiness_v2'

export function safeRevision(environment: HealthEnvironment = process.env): string {
  const raw = environment.MYCHAT_BUILD_REVISION?.trim()
    || environment.RENDER_GIT_COMMIT?.trim()
    || environment.VERCEL_GIT_COMMIT_SHA?.trim()
  return raw && /^[a-f0-9]{7,64}$/i.test(raw) ? raw.slice(0, 12).toLowerCase() : 'unknown'
}

/** Liveness is intentionally dependency-free: a dependency outage must not restart the process. */
export function getRuntimeLiveness(
  environment: HealthEnvironment = process.env,
): RuntimeLiveness {
  return { live: true, revision: safeRevision(environment) }
}

function isAuthConfigured(environment: HealthEnvironment): boolean {
  const hasUrl = Boolean(environment.SUPABASE_URL?.trim()
    || environment.NEXT_PUBLIC_SUPABASE_URL?.trim())
  return hasUrl && Boolean(environment.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim())
}

function boundedTimeoutMs(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs)) return 2_000
  return Math.min(10_000, Math.max(100, Math.floor(timeoutMs)))
}

function isReadyResult(data: unknown): boolean {
  if (data === true) return true
  if (Array.isArray(data)) return data[0] === true
  if (!data || typeof data !== 'object') return false
  return (data as { ready?: unknown }).ready === true
}

async function probeRpc(
  client: HealthRpcClient | null,
  rpcName: string,
  timeoutMs: number,
  args?: Record<string, unknown>,
): Promise<boolean> {
  if (!client) return false
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const raw = client.rpc(rpcName, args)
    const operation = typeof raw.abortSignal === 'function'
      ? raw.abortSignal(controller.signal)
      : raw
    const result = await Promise.race([
      Promise.resolve(operation),
      new Promise<null>(resolve => {
        timeout = setTimeout(() => {
          controller.abort()
          resolve(null)
        }, timeoutMs)
      }),
    ])
    if (!result || result.error) return false
    return isReadyResult(result.data)
  } catch {
    return false
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export async function probeWorker(
  client: HealthRpcClient | null,
  timeoutMs = 2_000,
  environment: HealthEnvironment = process.env,
): Promise<boolean> {
  const revision = safeRevision(environment)
  if (environment.NODE_ENV === 'production' && revision === 'unknown') return false
  return probeRpc(client, WORKER_READINESS_RPC, boundedTimeoutMs(timeoutMs), {
    input_required_queues: [...REQUIRED_JOB_WORKER_QUEUES],
    input_max_age_seconds: 20,
    input_revision: revision,
  })
}

export async function probeDatabase(
  client: HealthRpcClient | null,
  timeoutMs = 2_000,
): Promise<boolean> {
  // The database compares this build's closed migration manifest with its
  // immutable schema attestation and runtime v14 in one fail-closed RPC.
  return probeRpc(client, RUNTIME_HEALTHCHECK_RPC, boundedTimeoutMs(timeoutMs), {
    input_contract_version: MIGRATION_CONTRACT.version,
    input_manifest_sha256: MIGRATION_CONTRACT.digest,
    input_migration_count: MIGRATION_CONTRACT.migrationCount,
  })
}

async function probeQueue(
  queue: QueueReadinessProbe,
  timeoutMs: number,
): Promise<boolean> {
  if (!queue.configured) return false
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => queue.check()),
      new Promise<false>(resolve => {
        timeout = setTimeout(() => resolve(false), boundedTimeoutMs(timeoutMs))
      }),
    ])
    return result === true
  } catch {
    return false
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export async function getRuntimeHealth(
  environment: HealthEnvironment = process.env,
  client: HealthRpcClient | null = createAdminClient(),
  options: RuntimeHealthOptions = {},
): Promise<RuntimeHealth> {
  const authConfigured = isAuthConfigured(environment)
  const adminConfigured = isAdminConfigured(environment)
  const draining = jobMaintenanceMode(environment) === 'drain'
  const revision = safeRevision(environment)
  const streamKey = streamAdmissionHashKey(environment)
  const streamConfigured = Boolean(environment.STREAM_ADMISSION_HASH_KEY?.trim() && streamKey)
  const streamReady = streamKey !== null
  const metricsToken = metricsBearerToken(environment)
  const observabilityConfigured = Boolean(
    environment.METRICS_BEARER_TOKEN?.trim() && metricsToken,
  )
  const observabilityReady = environment.NODE_ENV !== 'production' || metricsToken !== null
  const [databaseReady, observedWorkerReady] = adminConfigured
    ? await Promise.all([
        probeDatabase(client, options.timeoutMs),
        probeWorker(client, options.timeoutMs, environment),
      ])
    : [false, false]
  // A maintenance instance remains ready for reads and status/cancel queries,
  // while command admission is closed and its worker advertises draining. Even
  // then, an unidentified production release must never report ready.
  const revisionReady = environment.NODE_ENV !== 'production' || revision !== 'unknown'
  const workerReady = draining ? databaseReady && revisionReady : observedWorkerReady
  // The database contract includes the durable database queue. An explicit
  // adapter lets a future external queue participate without changing routes.
  const queueConfigured = options.queue?.configured ?? adminConfigured
  const queueReady = options.queue
    ? databaseReady && await probeQueue(options.queue, options.timeoutMs ?? 2_000)
    : databaseReady
  const sandboxConfigured = isolatedSandboxConfigured(environment)
  const sandboxReady = productionAgentSandboxReady(environment)
  return {
    ready: authConfigured && databaseReady && queueReady && workerReady && streamReady
      && observabilityReady && sandboxReady,
    revision,
    checks: {
      auth: { configured: authConfigured, ready: authConfigured },
      database: { configured: adminConfigured, ready: databaseReady },
      distributedRateLimit: { configured: adminConfigured, ready: databaseReady },
      queue: { configured: queueConfigured, ready: queueReady },
      worker: { configured: adminConfigured, ready: workerReady, draining },
      stream: { configured: streamConfigured, ready: streamReady },
      observability: { configured: observabilityConfigured, ready: observabilityReady },
      sandbox: { configured: sandboxConfigured, ready: sandboxReady },
    },
  }
}
