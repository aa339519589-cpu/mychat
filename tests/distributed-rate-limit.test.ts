import assert from 'node:assert/strict'
import test from 'node:test'
import { checkRateLimit } from '../lib/rate-limit'

test('production rate limiting fails closed without the server database client', async () => {
  const result = await checkRateLimit('production:user:1', { max: 10 }, {
    createAdminClient: () => null,
    environment: { NODE_ENV: 'production' },
  })

  assert.equal(result.allowed, false)
  assert.equal(result.unavailable, true)
  assert.equal(result.backend, 'unavailable')
})

test('distributed rate limiting hashes identity keys before the atomic RPC', async () => {
  let rpcName = ''
  let rpcArgs: Record<string, unknown> = {}
  const result = await checkRateLimit('user:sensitive-id', { max: 30, windowMs: 60_000 }, {
    environment: { NODE_ENV: 'production' },
    createAdminClient: () => ({
      rpc: async (name, args) => {
        rpcName = name
        rpcArgs = args
        return {
          data: [{ allowed: true, remaining: 29, retry_after_seconds: 0 }],
          error: null,
        }
      },
    }),
  })

  assert.equal(result.backend, 'database')
  assert.equal(result.allowed, true)
  assert.equal(rpcName, 'consume_api_rate_limit')
  assert.match(String(rpcArgs.input_key_hash), /^[a-f0-9]{64}$/)
  assert.equal(JSON.stringify(rpcArgs).includes('sensitive-id'), false)
  assert.equal(rpcArgs.input_limit, 30)
  assert.equal(rpcArgs.input_window_ms, 60_000)
})

test('production does not fall back to memory when the rate-limit RPC fails', async () => {
  const result = await checkRateLimit('production:user:db-down', { max: 30 }, {
    environment: { NODE_ENV: 'production' },
    createAdminClient: () => ({
      rpc: async () => ({ data: null, error: { code: 'database_unavailable' } }),
    }),
  })

  assert.equal(result.allowed, false)
  assert.equal(result.unavailable, true)
  assert.equal(result.backend, 'unavailable')
})

test('production rate limiting fails closed when the database RPC hangs', async () => {
  const startedAt = Date.now()
  const result = await checkRateLimit('production:user:db-hung', { max: 30 }, {
    environment: { NODE_ENV: 'production' },
    rpcTimeoutMs: 10,
    createAdminClient: () => ({
      rpc: () => new Promise(() => undefined),
    }),
  })

  assert.equal(result.allowed, false)
  assert.equal(result.unavailable, true)
  assert.equal(result.backend, 'unavailable')
  assert.ok(Date.now() - startedAt < 1_000)
})

test('local development can use the bounded in-memory fallback', async () => {
  const dependencies = {
    createAdminClient: () => null,
    environment: { NODE_ENV: 'development' },
    now: () => 123_000,
  } as const
  const first = await checkRateLimit('development:unique-key', { max: 1 }, dependencies)
  const second = await checkRateLimit('development:unique-key', { max: 1 }, dependencies)

  assert.equal(first.allowed, true)
  assert.equal(first.backend, 'memory')
  assert.equal(second.allowed, false)
  assert.equal(second.retryAfterSeconds, 60)
})

test('rate limiting handles invalid configuration and RPC exceptions by environment', async () => {
  const production = await checkRateLimit('production:invalid-config', {}, {
    environment: { NODE_ENV: 'production' },
    createAdminClient: () => { throw new Error('invalid credentials') },
  })
  assert.equal(production.backend, 'unavailable')
  assert.equal(production.allowed, false)

  const development = await checkRateLimit('development:rpc-throws', { max: 2 }, {
    environment: { NODE_ENV: 'development' },
    now: () => 500_000,
    createAdminClient: () => ({ rpc: async () => { throw new Error('offline') } }),
  })
  assert.equal(development.backend, 'memory')
  assert.equal(development.allowed, true)
  assert.equal(development.remaining, 1)
})

test('development falls back safely for timed out and malformed database results', async () => {
  const timeout = await checkRateLimit('development:timeout-fallback', { max: 1 }, {
    environment: { NODE_ENV: 'development' },
    now: () => 600_000,
    rpcTimeoutMs: 10,
    createAdminClient: () => ({ rpc: () => new Promise(() => undefined) }),
  })
  assert.equal(timeout.backend, 'memory')
  assert.equal(timeout.allowed, true)

  const malformedValues: unknown[] = [
    null,
    [],
    { allowed: 'yes', remaining: 1, retry_after_seconds: 0 },
    { allowed: true, remaining: 'bad', retry_after_seconds: 0 },
    { allowed: true, remaining: 1, retry_after_seconds: Number.NaN },
  ]
  for (const [index, data] of malformedValues.entries()) {
    const result = await checkRateLimit(`development:malformed:${index}`, { max: 1 }, {
      environment: { NODE_ENV: 'test' },
      now: () => 700_000,
      createAdminClient: () => ({ rpc: async () => ({ data, error: null }) }),
    })
    assert.equal(result.backend, 'memory')
    assert.equal(result.allowed, true)
  }
})

test('rate-limit options and database counters are clamped to safe bounds', async () => {
  const seen: Record<string, unknown>[] = []
  const client = {
    rpc: async (_name: string, args: Record<string, unknown>) => {
      seen.push(args)
      return {
        data: { allowed: false, remaining: -20, retry_after_seconds: 1.2 },
        error: null,
      }
    },
  }
  const low = await checkRateLimit('clamp:low', { max: -50, windowMs: 1 }, {
    environment: { NODE_ENV: 'production' },
    createAdminClient: () => client,
  })
  const high = await checkRateLimit('clamp:high', { max: 9_000_000, windowMs: 999_999_999_999 }, {
    environment: { NODE_ENV: 'production' },
    createAdminClient: () => client,
  })
  assert.equal(seen[0]?.input_limit, 1)
  assert.equal(seen[0]?.input_window_ms, 1_000)
  assert.equal(seen[1]?.input_limit, 100_000)
  assert.equal(seen[1]?.input_window_ms, 7 * 24 * 60 * 60 * 1_000)
  assert.equal(low.remaining, 0)
  assert.equal(low.retryAfterSeconds, 2)
  assert.equal(high.allowed, false)
})

test('development memory windows reset after expiry', async () => {
  let now = 800_000
  const dependencies = {
    createAdminClient: () => null,
    environment: { NODE_ENV: 'development' },
    now: () => now,
  } as const
  const first = await checkRateLimit('development:expiring-window', { max: 1, windowMs: 1_000 }, dependencies)
  const blocked = await checkRateLimit('development:expiring-window', { max: 1, windowMs: 1_000 }, dependencies)
  now += 1_001
  const reset = await checkRateLimit('development:expiring-window', { max: 1, windowMs: 1_000 }, dependencies)
  assert.equal(first.allowed, true)
  assert.equal(blocked.allowed, false)
  assert.equal(reset.allowed, true)
})
