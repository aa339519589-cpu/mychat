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
