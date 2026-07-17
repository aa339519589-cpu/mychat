import assert from 'node:assert/strict'
import test from 'node:test'
import {
  resolveRuntimeConfiguration,
  runtimeRole,
  type RuntimeEnvironment,
  type RuntimeRole,
} from '../lib/runtime-config'

const encodedSecret = '0'.repeat(64)

function productionEnvironment(overrides: Partial<RuntimeEnvironment> = {}): RuntimeEnvironment {
  return {
    NODE_ENV: 'production',
    MYCHAT_BUILD_REVISION: 'abcdef0123456789abcdef0123456789abcdef01',
    NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'sb_publishable_public_test_key',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-material-000000000001',
    STREAM_ADMISSION_HASH_KEY: 'stream-admission-key-material-000000001',
    METRICS_BEARER_TOKEN: encodedSecret,
    E2B_API_KEY: 'e2b-key',
    DEEPSEEK_API_KEY: 'deepseek-key',
    AGENT_CREDENTIAL_KEY: 'agent-credential-key-material-00000001',
    AGENT_PUBLIC_URL: 'https://mychat.example',
    GITHUB_CLIENT_ID: 'github-client',
    GITHUB_CLIENT_SECRET: 'github-client-secret-material-00000001',
    ...overrides,
  }
}

test('runtime configuration is role-aware, immutable, and applies bounded worker defaults', () => {
  const all = resolveRuntimeConfiguration(productionEnvironment())
  assert.equal(all.role, 'all')
  assert.deepEqual(all.services, ['web', 'worker'])
  assert.equal(all.revision, 'abcdef012345')
  assert.deepEqual(all.workerConcurrency, { chat: 2, media: 1, title: 1, agent: 1 })
  assert.equal(Object.isFrozen(all), true)
  assert.equal(Object.isFrozen(all.workerConcurrency), true)

  const web = resolveRuntimeConfiguration(productionEnvironment({
    MYCHAT_RUNTIME_ROLE: 'web',
    E2B_API_KEY: undefined,
    DEEPSEEK_API_KEY: undefined,
  }))
  assert.deepEqual(web.services, ['web'])

  const worker = resolveRuntimeConfiguration(productionEnvironment({
    MYCHAT_RUNTIME_ROLE: 'worker',
    STREAM_ADMISSION_HASH_KEY: undefined,
    METRICS_BEARER_TOKEN: undefined,
    AGENT_PUBLIC_URL: undefined,
    GITHUB_CLIENT_ID: undefined,
    GITHUB_CLIENT_SECRET: undefined,
  }))
  assert.deepEqual(worker.services, ['worker'])
})

test('production roles fail before process start on missing or malformed owned configuration', () => {
  const cases: Array<[RuntimeRole, keyof RuntimeEnvironment, string | undefined, RegExp]> = [
    ['all', 'MYCHAT_BUILD_REVISION', undefined, /immutable build revision/],
    ['web', 'NEXT_PUBLIC_SUPABASE_URL', 'http://project.local', /HTTPS URL/],
    ['web', 'STREAM_ADMISSION_HASH_KEY', 'short', /at least 32 bytes/],
    ['web', 'METRICS_BEARER_TOKEN', 'plain text is not encoded', /encoded secret/],
    ['web', 'AGENT_PUBLIC_URL', 'http://mychat.example', /HTTPS URL/],
    ['worker', 'SUPABASE_SERVICE_ROLE_KEY', 'short', /at least 32 bytes/],
    ['worker', 'DEEPSEEK_API_KEY', undefined, /DEEPSEEK_API_KEY/],
    ['worker', 'E2B_API_KEY', undefined, /E2B_API_KEY/],
    ['worker', 'AGENT_CREDENTIAL_KEY', 'short', /at least 32 bytes/],
    ['worker', 'JOB_AGENT_CONCURRENCY', '17', /between 1 and 16/],
  ]
  for (const [role, field, value, expected] of cases) {
    assert.throws(
      () => resolveRuntimeConfiguration(productionEnvironment({
        MYCHAT_RUNTIME_ROLE: role,
        [field]: value,
      })),
      expected,
      `${role}:${String(field)}`,
    )
  }
})

test('optional credential pairs and rotation keys are all-or-nothing', () => {
  assert.throws(() => resolveRuntimeConfiguration({
    GITHUB_CLIENT_ID: 'client-only',
  }), /configured together/)
  assert.throws(() => resolveRuntimeConfiguration({
    AGENT_CREDENTIAL_KEY_PREVIOUS: encodedSecret,
  }), /requires AGENT_CREDENTIAL_KEY/)
  assert.throws(() => resolveRuntimeConfiguration(productionEnvironment({
    AGENT_CREDENTIAL_KEY_PREVIOUS: 'agent-credential-key-material-00000001',
  })), /must differ/)
})

test('runtime roles and enums reject deployment typos in every environment', () => {
  assert.equal(runtimeRole(undefined), 'all')
  assert.throws(() => runtimeRole('api'), /expected all, web, or worker/)
  assert.throws(() => resolveRuntimeConfiguration({ MYCHAT_MAINTENANCE_MODE: 'paused' }), /off or drain/)
  assert.throws(() => resolveRuntimeConfiguration({ MYCHAT_WORKFLOW_RUNTIME: 'postgres-v2' }), /postgres-v1 or legacy/)
  assert.throws(() => resolveRuntimeConfiguration({ JOB_WORKER_ID: 'bad\nworker' }), /printable identifier/)
})
