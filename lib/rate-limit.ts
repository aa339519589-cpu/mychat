import { createHash } from 'node:crypto'
import { log } from '@/lib/logger'
import { createAdminClient } from '@/lib/supabase/admin'

const RATE_LIMIT_MAX = 30
const WINDOW_MS = 60 * 1000
const MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const MAX_REQUESTS_PER_WINDOW = 100_000
const RATE_LIMIT_RPC_TIMEOUT_MS = 2_000

interface RateLimitEntry {
  count: number
  resetAt: number
}

type RateLimitStore = Map<string, RateLimitEntry>
type RateLimitEnvironment = Pick<NodeJS.ProcessEnv, 'NODE_ENV'>
type RateLimitRpcClient = {
  rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{
    data: unknown
    error: { code?: string; message?: string } | null
  }>
}

export type RateLimitResult = {
  allowed: boolean
  remaining: number
  retryAfterSeconds: number
  backend: 'database' | 'memory' | 'unavailable'
  unavailable?: boolean
}

type RateLimitDependencies = {
  createAdminClient: () => RateLimitRpcClient | null
  environment: RateLimitEnvironment
  now: () => number
  rpcTimeoutMs: number
}

const globalStore = globalThis as typeof globalThis & {
  __mychatRateLimitStore?: RateLimitStore
  __mychatRateLimitLastSweep?: number
}

// Reused only as a local-development fallback. Production never reaches this store.
const store = globalStore.__mychatRateLimitStore ??= new Map<string, RateLimitEntry>()

function normalizeOptions(options: { max?: number; windowMs?: number }) {
  const requestedMax = Number.isFinite(options.max) ? Number(options.max) : RATE_LIMIT_MAX
  const requestedWindow = Number.isFinite(options.windowMs) ? Number(options.windowMs) : WINDOW_MS
  return {
    max: Math.min(MAX_REQUESTS_PER_WINDOW, Math.max(1, Math.floor(requestedMax))),
    windowMs: Math.min(MAX_WINDOW_MS, Math.max(1000, Math.floor(requestedWindow))),
  }
}

function checkMemoryRateLimit(
  key: string,
  max: number,
  windowMs: number,
  now: number,
): RateLimitResult {
  const storageKey = `ratelimit:${key}`
  const entry = store.get(storageKey)

  // Request-driven cleanup avoids keeping serverless instances alive with a timer.
  if (!globalStore.__mychatRateLimitLastSweep
    || now - globalStore.__mychatRateLimitLastSweep > 5 * 60_000) {
    for (const [storedKey, storedEntry] of store) {
      if (now >= storedEntry.resetAt) store.delete(storedKey)
    }
    globalStore.__mychatRateLimitLastSweep = now
  }

  if (!entry || now >= entry.resetAt) {
    store.set(storageKey, { count: 1, resetAt: now + windowMs })
    return { allowed: true, remaining: max - 1, retryAfterSeconds: 0, backend: 'memory' }
  }

  if (entry.count >= max) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
      backend: 'memory',
    }
  }

  entry.count += 1
  return {
    allowed: true,
    remaining: max - entry.count,
    retryAfterSeconds: 0,
    backend: 'memory',
  }
}

function unavailableResult(): RateLimitResult {
  return {
    allowed: false,
    remaining: 0,
    retryAfterSeconds: 1,
    backend: 'unavailable',
    unavailable: true,
  }
}

function parseDatabaseResult(data: unknown): RateLimitResult | null {
  const value = Array.isArray(data) ? data[0] : data
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  if (typeof row.allowed !== 'boolean') return null
  const remaining = Number(row.remaining)
  const retryAfterSeconds = Number(row.retry_after_seconds)
  if (!Number.isFinite(remaining) || !Number.isFinite(retryAfterSeconds)) return null
  return {
    allowed: row.allowed,
    remaining: Math.max(0, Math.floor(remaining)),
    retryAfterSeconds: Math.max(0, Math.ceil(retryAfterSeconds)),
    backend: 'database',
  }
}

/**
 * Atomically consumes one request from a fixed database window.
 *
 * Production is fail-closed: missing service credentials, a missing migration,
 * or a database failure returns `unavailable` and never falls back to per-process state.
 * Local development and tests retain the in-memory fallback for easy startup.
 */
export async function checkRateLimit(
  key: string,
  options: { max?: number; windowMs?: number } = {},
  dependencyOverrides: Partial<RateLimitDependencies> = {},
): Promise<RateLimitResult> {
  const dependencies: RateLimitDependencies = {
    createAdminClient,
    environment: process.env,
    now: Date.now,
    rpcTimeoutMs: RATE_LIMIT_RPC_TIMEOUT_MS,
    ...dependencyOverrides,
  }
  const { max, windowMs } = normalizeOptions(options)
  const requiresDatabase = dependencies.environment.NODE_ENV === 'production'
  let admin: RateLimitRpcClient | null = null
  try {
    admin = dependencies.createAdminClient()
  } catch (error) {
    log.error('rateLimit', 'Distributed rate limit configuration is invalid', {
      name: error instanceof Error ? error.name : 'unknown',
    })
  }

  if (admin) {
    const keyHash = createHash('sha256').update(key).digest('hex')
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        admin.rpc('consume_api_rate_limit', {
          input_key_hash: keyHash,
          input_limit: max,
          input_window_ms: windowMs,
        }),
        new Promise<null>(resolve => {
          timeout = setTimeout(() => resolve(null), Math.max(10, dependencies.rpcTimeoutMs))
        }),
      ])
      if (!result) {
        log.warn('rateLimit', 'Distributed rate limit timed out')
        if (requiresDatabase) return unavailableResult()
        return checkMemoryRateLimit(key, max, windowMs, dependencies.now())
      }
      const { data, error } = result
      const parsed = error ? null : parseDatabaseResult(data)
      if (parsed) return parsed
      log.warn('rateLimit', 'Distributed rate limit unavailable', {
        code: error?.code ?? 'invalid_response',
      })
    } catch (error) {
      log.warn('rateLimit', 'Distributed rate limit exception', {
        name: error instanceof Error ? error.name : 'unknown',
      })
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  } else if (requiresDatabase) {
    log.error('rateLimit', 'Distributed rate limit is not configured')
  }

  if (requiresDatabase) return unavailableResult()
  return checkMemoryRateLimit(key, max, windowMs, dependencies.now())
}
