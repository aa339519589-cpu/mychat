import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getRuntimeHealth,
  getRuntimeLiveness,
  probeDatabase,
  safeRevision,
} from '../lib/supabase/health'

test('health revision is allow-listed, shortened, and prefers Render', () => {
  assert.equal(safeRevision({
    RENDER_GIT_COMMIT: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01',
    VERCEL_GIT_COMMIT_SHA: '1111111111111111111111111111111111111111',
  }), 'abcdef012345')
  assert.equal(safeRevision({ RENDER_GIT_COMMIT: 'not a safe revision' }), 'unknown')
})

test('database readiness requires a successful migration-aware RPC', async () => {
  let rpcName = ''
  assert.equal(await probeDatabase(null), false)
  assert.equal(await probeDatabase({
    rpc: async name => {
      rpcName = name
      return { data: true, error: null }
    },
  }), true)
  assert.equal(rpcName, 'runtime_healthcheck_v5')
  assert.equal(await probeDatabase({
    rpc: async () => ({ data: null, error: { code: 'missing_function' } }),
  }, 2_000, { NODE_ENV: 'production' }), false)
})

test('production readiness never falls back to an older infrastructure contract', async () => {
  const calls: string[] = []
  const ready = await probeDatabase({
    rpc: async name => {
      calls.push(name)
      return { data: name === 'runtime_healthcheck_v4', error: null }
    },
  }, 2_000, { NODE_ENV: 'production' })

  assert.equal(ready, false)
  assert.deepEqual(calls, ['runtime_healthcheck_v5'])
})

test('local development can fall back while the v5 migration is being applied', async () => {
  const calls: string[] = []
  const ready = await probeDatabase({
    rpc: async name => {
      calls.push(name)
      return name === 'runtime_healthcheck_v5'
        ? { data: null, error: { code: 'missing_function' } }
        : { data: true, error: null }
    },
  }, 2_000, { NODE_ENV: 'development' })

  assert.equal(ready, true)
  assert.deepEqual(calls, ['runtime_healthcheck_v5', 'runtime_healthcheck_v4'])
})

test('runtime health reports only safe configured and ready state', async () => {
  const environment = {
    NEXT_PUBLIC_SUPABASE_URL: 'https://private-project.example',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'public-anon-value',
    SUPABASE_SERVICE_ROLE_KEY: 'super-secret-service-key',
    RENDER_GIT_COMMIT: 'abcdef0123456789abcdef0123456789abcdef01',
  }
  const health = await getRuntimeHealth(environment, {
    rpc: async () => ({ data: true, error: null }),
  })

  assert.equal(health.ready, true)
  assert.equal(health.revision, 'abcdef012345')
  assert.deepEqual(health.checks.distributedRateLimit, { configured: true, ready: true })
  assert.deepEqual(health.checks.queue, { configured: true, ready: true })
  assert.deepEqual(health.checks.sandbox, { configured: false, ready: true })
  const serialized = JSON.stringify(health)
  assert.equal(serialized.includes('super-secret-service-key'), false)
  assert.equal(serialized.includes('private-project.example'), false)
})

test('an injected queue probe participates in strict readiness and fails closed', async () => {
  const environment = {
    NODE_ENV: 'production',
    NEXT_PUBLIC_SUPABASE_URL: 'https://private-project.example',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'public-anon-value',
    SUPABASE_SERVICE_ROLE_KEY: 'super-secret-service-key',
    E2B_API_KEY: 'e2b-secret-key',
  }
  const health = await getRuntimeHealth(environment, {
    rpc: async () => ({ data: true, error: null }),
  }, {
    queue: { configured: true, check: async () => false },
  })

  assert.equal(health.ready, false)
  assert.deepEqual(health.checks.queue, { configured: true, ready: false })
})

test('production readiness fails closed without an isolated agent sandbox', async () => {
  const baseEnvironment = {
    NODE_ENV: 'production',
    NEXT_PUBLIC_SUPABASE_URL: 'https://private-project.example',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'public-anon-value',
    SUPABASE_SERVICE_ROLE_KEY: 'super-secret-service-key',
  }
  const client = { rpc: async () => ({ data: true, error: null }) }

  const missing = await getRuntimeHealth(baseEnvironment, client)
  assert.equal(missing.ready, false)
  assert.deepEqual(missing.checks.sandbox, { configured: false, ready: false })

  const whitespace = await getRuntimeHealth({ ...baseEnvironment, E2B_API_KEY: '  ' }, client)
  assert.equal(whitespace.ready, false)
  assert.deepEqual(whitespace.checks.sandbox, { configured: false, ready: false })

  const configured = await getRuntimeHealth({ ...baseEnvironment, E2B_API_KEY: 'e2b-key' }, client)
  assert.equal(configured.ready, true)
  assert.deepEqual(configured.checks.sandbox, { configured: true, ready: true })
})

test('liveness is dependency-free and contains only safe process metadata', () => {
  assert.deepEqual(getRuntimeLiveness({
    RENDER_GIT_COMMIT: 'abcdef0123456789abcdef0123456789abcdef01',
    SUPABASE_SERVICE_ROLE_KEY: 'not-for-output',
  }), {
    live: true,
    revision: 'abcdef012345',
  })
})
