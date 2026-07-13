import { createAdminClient, isAdminConfigured } from './admin'
import {
  isolatedSandboxConfigured,
  productionAgentSandboxReady,
} from '@/lib/agent/execution-policy'

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
}

type HealthRpcClient = {
  rpc: (name: string) => PromiseLike<{
    data: unknown
    error: unknown
  }>
}

export type RuntimeHealth = {
  ready: boolean
  revision: string
  checks: {
    auth: { configured: boolean; ready: boolean }
    database: { configured: boolean; ready: boolean }
    distributedRateLimit: { configured: boolean; ready: boolean }
    queue: { configured: boolean; ready: boolean }
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

const RUNTIME_HEALTHCHECK_RPC = 'runtime_healthcheck_v5'
const DEVELOPMENT_FALLBACK_RPC = 'runtime_healthcheck_v4'

export function safeRevision(environment: HealthEnvironment = process.env): string {
  const raw = environment.RENDER_GIT_COMMIT?.trim()
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
): Promise<boolean> {
  if (!client) return false
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      client.rpc(rpcName),
      new Promise<null>(resolve => {
        timeout = setTimeout(() => resolve(null), timeoutMs)
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

export async function probeDatabase(
  client: HealthRpcClient | null,
  timeoutMs = 2_000,
  environment: HealthEnvironment = process.env,
): Promise<boolean> {
  const boundedTimeout = boundedTimeoutMs(timeoutMs)
  // v5 is the queue-aware, private-storage infrastructure contract. A structurally older
  // database must not receive production traffic from this application.
  if (await probeRpc(client, RUNTIME_HEALTHCHECK_RPC, boundedTimeout)) return true
  if (environment.NODE_ENV === 'production') return false
  return probeRpc(client, DEVELOPMENT_FALLBACK_RPC, boundedTimeout)
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
  const databaseReady = adminConfigured
    && await probeDatabase(client, options.timeoutMs, environment)
  // The v4 database contract includes the durable database queue. An explicit
  // adapter lets a future external queue participate without changing routes.
  const queueConfigured = options.queue?.configured ?? adminConfigured
  const queueReady = options.queue
    ? databaseReady && await probeQueue(options.queue, options.timeoutMs ?? 2_000)
    : databaseReady
  const sandboxConfigured = isolatedSandboxConfigured(environment)
  const sandboxReady = productionAgentSandboxReady(environment)
  return {
    ready: authConfigured && databaseReady && queueReady && sandboxReady,
    revision: safeRevision(environment),
    checks: {
      auth: { configured: authConfigured, ready: authConfigured },
      database: { configured: adminConfigured, ready: databaseReady },
      distributedRateLimit: { configured: adminConfigured, ready: databaseReady },
      queue: { configured: queueConfigured, ready: queueReady },
      sandbox: { configured: sandboxConfigured, ready: sandboxReady },
    },
  }
}
