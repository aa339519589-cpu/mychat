import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getRuntimeHealth,
  getRuntimeLiveness,
  probeDatabase,
  probeWorker,
  safeRevision,
} from '../lib/supabase/health'
import { MIGRATION_CONTRACT } from '../lib/supabase/migration-contract'

const METRICS_TOKEN = '0123456789abcdef'.repeat(4)

test('health revision is allow-listed, shortened, and prefers the built artifact', () => {
  assert.equal(safeRevision({
    MYCHAT_BUILD_REVISION: '2222222222222222222222222222222222222222',
    RENDER_GIT_COMMIT: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01',
    VERCEL_GIT_COMMIT_SHA: '1111111111111111111111111111111111111111',
  }), '222222222222')
  assert.equal(safeRevision({
    RENDER_GIT_COMMIT: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01',
    VERCEL_GIT_COMMIT_SHA: '1111111111111111111111111111111111111111',
  }), 'abcdef012345')
  assert.equal(safeRevision({
    VERCEL_GIT_COMMIT_SHA: '1111111111111111111111111111111111111111',
  }), '111111111111')
  assert.equal(safeRevision({}), 'unknown')
  assert.equal(safeRevision({ RENDER_GIT_COMMIT: 'not a safe revision' }), 'unknown')
})

test('database readiness requires a successful migration-aware RPC', async () => {
  let rpcName = ''
  let rpcArgs: Record<string, unknown> | undefined
  assert.equal(await probeDatabase(null), false)
  assert.equal(await probeDatabase({
    rpc: async (name, args) => {
      rpcName = name
      rpcArgs = args
      return { data: true, error: null }
    },
  }), true)
  assert.equal(rpcName, 'verify_schema_contract_v2')
  assert.deepEqual(rpcArgs, {
    input_contract_version: MIGRATION_CONTRACT.version,
    input_manifest_sha256: MIGRATION_CONTRACT.digest,
    input_migration_count: MIGRATION_CONTRACT.migrationCount,
  })
  assert.equal(await probeDatabase({
    rpc: async () => ({ data: null, error: { code: 'missing_function' } }),
  }), false)
})

test('database readiness accepts only explicit ready envelopes and contains RPC failures', async () => {
  for (const data of [[true], { ready: true }]) {
    assert.equal(await probeDatabase({ rpc: async () => ({ data, error: null }) }), true)
  }
  for (const data of [false, [false], { ready: false }, {}, null]) {
    assert.equal(await probeDatabase({ rpc: async () => ({ data, error: null }) }, 2_000), false)
  }
  assert.equal(await probeDatabase({
    rpc: async () => { throw new Error('offline') },
  }, 2_000), false)
  assert.equal(await probeDatabase({
    rpc: () => new Promise(() => undefined),
  }, 1), false)
})

test('production readiness never falls back to an older infrastructure contract', async () => {
  const calls: string[] = []
  const ready = await probeDatabase({
    rpc: async name => {
      calls.push(name)
      return { data: name === 'runtime_healthcheck_v8', error: null }
    },
  })

  assert.equal(ready, false)
  assert.deepEqual(calls, ['verify_schema_contract_v2'])
})

test('local development also refuses an older infrastructure contract', async () => {
  const calls: string[] = []
  const ready = await probeDatabase({
    rpc: async name => {
      calls.push(name)
      return name === 'verify_schema_contract_v2'
        ? { data: null, error: { code: 'missing_function' } }
        : { data: true, error: null }
    },
  })

  assert.equal(ready, false)
  assert.deepEqual(calls, ['verify_schema_contract_v2'])
})

test('readiness timeout aborts an abortable PostgREST request', async () => {
  let attached = false
  let aborted = false
  const pending = new Promise<{ data: unknown; error: unknown }>(() => undefined)
  const request = Object.assign(pending, {
    abortSignal(signal: AbortSignal) {
      attached = true
      signal.addEventListener('abort', () => { aborted = true }, { once: true })
      return pending
    },
  })
  assert.equal(await probeDatabase({ rpc: () => request }, 1), false)
  assert.equal(attached, true)
  assert.equal(aborted, true)
})

test('worker readiness requires fresh coverage from every production consumer', async () => {
  let calledArgs: Record<string, unknown> | undefined
  assert.equal(await probeWorker(null), false)
  assert.equal(await probeWorker({
    rpc: async (name, args) => {
      assert.equal(name, 'read_job_worker_readiness_v3')
      calledArgs = args
      return { data: { ready: true }, error: null }
    },
  }, 2_000, {
    NODE_ENV: 'production',
    RENDER_GIT_COMMIT: 'abcdef0123456789abcdef0123456789abcdef01',
  }), true)
  assert.deepEqual(calledArgs?.input_required_queues, ['chat', 'media', 'title', 'agent', 'outbox'])
  assert.equal(calledArgs?.input_revision, 'abcdef012345')
  assert.equal(await probeWorker({
    rpc: async () => ({ data: { ready: false, missingQueues: ['media'] }, error: null }),
  }), false)
  assert.equal(await probeWorker({
    rpc: async () => {
      throw new Error('must not query an unscoped production revision')
    },
  }, 2_000, { NODE_ENV: 'production' }), false)
})

test('runtime health reports only safe configured and ready state', async () => {
  const environment = {
    NODE_ENV: 'development',
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
  assert.deepEqual(health.checks.worker, { configured: true, ready: true, draining: false })
  assert.deepEqual(health.checks.stream, { configured: false, ready: true })
  assert.deepEqual(health.checks.observability, { configured: false, ready: true })
  assert.deepEqual(health.checks.sandbox, { configured: false, ready: true })
  const serialized = JSON.stringify(health)
  assert.equal(serialized.includes('super-secret-service-key'), false)
  assert.equal(serialized.includes('private-project.example'), false)
})

test('runtime health exposes a closed configuration state without dependencies', async () => {
  const health = await getRuntimeHealth({ NODE_ENV: 'production' }, null)
  assert.equal(health.ready, false)
  assert.deepEqual(health.checks.auth, { configured: false, ready: false })
  assert.deepEqual(health.checks.database, { configured: false, ready: false })
  assert.deepEqual(health.checks.queue, { configured: false, ready: false })
})

test('an injected queue probe participates in strict readiness and fails closed', async () => {
  const environment = {
    NODE_ENV: 'production',
    NEXT_PUBLIC_SUPABASE_URL: 'https://private-project.example',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'public-anon-value',
    SUPABASE_SERVICE_ROLE_KEY: 'super-secret-service-key',
    E2B_API_KEY: 'e2b-secret-key',
    STREAM_ADMISSION_HASH_KEY: 'stream-admission-test-key-material-00000001',
    METRICS_BEARER_TOKEN: METRICS_TOKEN,
    RENDER_GIT_COMMIT: 'abcdef0123456789abcdef0123456789abcdef01',
  }
  const health = await getRuntimeHealth(environment, {
    rpc: async () => ({ data: true, error: null }),
  }, {
    queue: { configured: true, check: async () => false },
  })

  assert.equal(health.ready, false)
  assert.deepEqual(health.checks.queue, { configured: true, ready: false })
})

test('runtime readiness fails closed when worker coverage is stale', async () => {
  const environment = {
    NODE_ENV: 'production',
    NEXT_PUBLIC_SUPABASE_URL: 'https://private-project.example',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'public-anon-value',
    SUPABASE_SERVICE_ROLE_KEY: 'super-secret-service-key',
    E2B_API_KEY: 'e2b-secret-key',
    STREAM_ADMISSION_HASH_KEY: 'stream-admission-test-key-material-00000001',
    METRICS_BEARER_TOKEN: METRICS_TOKEN,
    RENDER_GIT_COMMIT: 'abcdef0123456789abcdef0123456789abcdef01',
  }
  const health = await getRuntimeHealth(environment, {
    rpc: async name => name === 'verify_schema_contract_v2'
      ? { data: true, error: null }
      : { data: { ready: false, missingQueues: ['agent'] }, error: null },
  })
  assert.equal(health.ready, false)
  assert.deepEqual(health.checks.worker, { configured: true, ready: false, draining: false })
})

test('maintenance drain remains read-ready while exposing the intentional worker state', async () => {
  const environment = {
    NODE_ENV: 'production',
    NEXT_PUBLIC_SUPABASE_URL: 'https://private-project.example',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'public-anon-value',
    SUPABASE_SERVICE_ROLE_KEY: 'super-secret-service-key',
    E2B_API_KEY: 'e2b-secret-key',
    MYCHAT_MAINTENANCE_MODE: 'drain',
    STREAM_ADMISSION_HASH_KEY: 'stream-admission-test-key-material-00000001',
    METRICS_BEARER_TOKEN: METRICS_TOKEN,
    RENDER_GIT_COMMIT: 'abcdef0123456789abcdef0123456789abcdef01',
  }
  const health = await getRuntimeHealth(environment, {
    rpc: async name => name === 'verify_schema_contract_v2'
      ? { data: true, error: null }
      : { data: { ready: false, missingQueues: ['chat'] }, error: null },
  })
  assert.equal(health.ready, true)
  assert.deepEqual(health.checks.worker, { configured: true, ready: true, draining: true })
})

test('maintenance drain cannot hide an unidentified production release', async () => {
  const health = await getRuntimeHealth({
    NODE_ENV: 'production',
    NEXT_PUBLIC_SUPABASE_URL: 'https://private-project.example',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'public-anon-value',
    SUPABASE_SERVICE_ROLE_KEY: 'super-secret-service-key',
    E2B_API_KEY: 'e2b-secret-key',
    MYCHAT_MAINTENANCE_MODE: 'drain',
    STREAM_ADMISSION_HASH_KEY: 'stream-admission-test-key-material-00000001',
    METRICS_BEARER_TOKEN: METRICS_TOKEN,
  }, {
    rpc: async name => name === 'verify_schema_contract_v2'
      ? { data: true, error: null }
      : { data: { ready: true }, error: null },
  })
  assert.equal(health.revision, 'unknown')
  assert.equal(health.ready, false)
  assert.deepEqual(health.checks.worker, { configured: true, ready: false, draining: true })
})

test('queue readiness rejects disabled and throwing adapters', async () => {
  const environment = {
    NODE_ENV: 'production',
    SUPABASE_URL: 'https://private-project.example',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'public-anon-value',
    SUPABASE_SERVICE_ROLE_KEY: 'super-secret-service-key',
    E2B_API_KEY: 'e2b-secret-key',
  }
  const client = { rpc: async () => ({ data: { ready: true }, error: null }) }
  const disabled = await getRuntimeHealth(environment, client, {
    queue: { configured: false, check: () => true },
  })
  assert.equal(disabled.ready, false)
  assert.deepEqual(disabled.checks.queue, { configured: false, ready: false })

  const throwing = await getRuntimeHealth(environment, client, {
    queue: { configured: true, check: () => { throw new Error('queue offline') } },
  })
  assert.equal(throwing.ready, false)
  assert.deepEqual(throwing.checks.queue, { configured: true, ready: false })
})

test('production readiness fails closed without an isolated agent sandbox', async () => {
  const baseEnvironment = {
    NODE_ENV: 'production',
    NEXT_PUBLIC_SUPABASE_URL: 'https://private-project.example',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'public-anon-value',
    SUPABASE_SERVICE_ROLE_KEY: 'super-secret-service-key',
    STREAM_ADMISSION_HASH_KEY: 'stream-admission-test-key-material-00000001',
    METRICS_BEARER_TOKEN: METRICS_TOKEN,
    RENDER_GIT_COMMIT: 'abcdef0123456789abcdef0123456789abcdef01',
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

test('production requires a dedicated stream admission key for readiness', async () => {
  const baseEnvironment = {
    NODE_ENV: 'production',
    NEXT_PUBLIC_SUPABASE_URL: 'https://private-project.example',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'public-anon-value',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-that-must-never-be-reused',
    E2B_API_KEY: 'e2b-key',
    METRICS_BEARER_TOKEN: METRICS_TOKEN,
    RENDER_GIT_COMMIT: 'abcdef0123456789abcdef0123456789abcdef01',
  }
  const client = { rpc: async () => ({ data: true, error: null }) }

  const missing = await getRuntimeHealth(baseEnvironment, client)
  assert.equal(missing.ready, false)
  assert.deepEqual(missing.checks.stream, { configured: false, ready: false })

  const short = await getRuntimeHealth({
    ...baseEnvironment,
    STREAM_ADMISSION_HASH_KEY: 'too-short',
  }, client)
  assert.equal(short.ready, false)
  assert.deepEqual(short.checks.stream, { configured: false, ready: false })

  const configured = await getRuntimeHealth({
    ...baseEnvironment,
    STREAM_ADMISSION_HASH_KEY: 'stream-admission-test-key-material-00000001',
  }, client)
  assert.equal(configured.ready, true)
  assert.deepEqual(configured.checks.stream, { configured: true, ready: true })
})

test('production readiness requires a strong metrics authentication secret', async () => {
  const environment = {
    NODE_ENV: 'production',
    NEXT_PUBLIC_SUPABASE_URL: 'https://private-project.example',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'public-anon-value',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    E2B_API_KEY: 'e2b-key',
    STREAM_ADMISSION_HASH_KEY: 'stream-admission-test-key-material-00000001',
    RENDER_GIT_COMMIT: 'abcdef0123456789abcdef0123456789abcdef01',
  }
  const client = { rpc: async () => ({ data: true, error: null }) }
  const missing = await getRuntimeHealth(environment, client)
  assert.equal(missing.ready, false)
  assert.deepEqual(missing.checks.observability, { configured: false, ready: false })

  const weak = await getRuntimeHealth({
    ...environment,
    METRICS_BEARER_TOKEN: 'too-short',
  }, client)
  assert.equal(weak.ready, false)
  assert.deepEqual(weak.checks.observability, { configured: false, ready: false })

  const configured = await getRuntimeHealth({
    ...environment,
    METRICS_BEARER_TOKEN: METRICS_TOKEN,
  }, client)
  assert.equal(configured.ready, true)
  assert.deepEqual(configured.checks.observability, { configured: true, ready: true })
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
