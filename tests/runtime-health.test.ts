import assert from 'node:assert/strict'
import test from 'node:test'
import { getRuntimeHealth, probeDatabase, safeRevision } from '../lib/supabase/health'

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
  assert.equal(rpcName, 'runtime_healthcheck_v3')
  assert.equal(await probeDatabase({
    rpc: async () => ({ data: null, error: { code: 'missing_function' } }),
  }), false)
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
  const serialized = JSON.stringify(health)
  assert.equal(serialized.includes('super-secret-service-key'), false)
  assert.equal(serialized.includes('private-project.example'), false)
})
