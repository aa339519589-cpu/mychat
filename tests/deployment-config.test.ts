import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { resolve } from 'node:path'

const root = process.cwd()

function read(path: string) {
  return readFileSync(resolve(root, path), 'utf8')
}

test('CI and Render use the supported Node runtime and strict readiness', () => {
  const packageJson = JSON.parse(read('package.json')) as { engines?: { node?: string } }
  const workflow = read('.github/workflows/verify.yml')
  const render = read('render.yaml')

  assert.equal(packageJson.engines?.node, '>=24')
  assert.match(workflow, /node-version:\s*24/)
  assert.match(workflow, /playwright install --with-deps chromium/)
  assert.match(render, /healthCheckPath:\s*\/api\/ready/)
  assert.match(render, /autoDeployTrigger:\s*off/)
  assert.match(render, /key:\s*MYCHAT_MAINTENANCE_MODE\s*\n\s*sync:\s*false/)
  assert.match(render, /key:\s*NODE_VERSION\s*\n\s*value:\s*24/)
  assert.equal(render.match(/key:\s*NODE_ENV\s*\n\s*value:\s*production/g)?.length, 1)
  assert.equal(render.match(/^\s*- type:/gm)?.length, 1)
  assert.doesNotMatch(render, /type:\s*worker/)
  assert.match(read('package.json'), /"prestart":\s*"tsx scripts\/assert-production-agent-sandbox\.ts"/)
  assert.match(read('package.json'), /"start":\s*"node scripts\/start-production\.mjs"/)
  assert.match(read('job-worker.ts'), /assertProductionAgentSandbox\(\)/)
  assert.match(read('lib/agent/isolated-shell.ts'), /network:\s*\{\s*allowOut\s*\}/)
  assert.match(read('lib/agent/isolated-shell.ts'), /updateNetwork\(\{\s*allowOut\s*\}\)/)
})

test('worker deployment has queue bulkheads and a sub-three-second cancellation poll', () => {
  const render = read('render.yaml')
  const worker = read('job-worker.ts')
  const supervisor = read('scripts/start-production.mjs')
  const keepalive = read('.github/workflows/render-keepalive.yml')
  const healthVerifier = read('scripts/check-production-health.mjs')

  for (const queue of ['CHAT', 'MEDIA', 'TITLE', 'AGENT']) {
    assert.match(render, new RegExp(`key:\\s*JOB_${queue}_CONCURRENCY`))
  }
  for (const queue of ['chat', 'media', 'title', 'agent']) {
    assert.match(worker, new RegExp(`\\{ name: '${queue}', queue: '${queue}', concurrency:`))
  }
  assert.match(worker, /const heartbeatSpecs = \[/)
  assert.match(worker, /\{ name: 'outbox', queue: 'outbox', capacity: 1 \}/)
  assert.match(worker, /queues:\s*\[spec\.queue\]/)
  assert.match(worker, /capacity:\s*spec\.capacity/)
  assert.match(worker, /renewIntervalMs:\s*2_000/)
  assert.doesNotMatch(worker, /queues:\s*\['chat',\s*'media'/)
  assert.match(supervisor, /next\/dist\/bin\/next/)
  assert.match(supervisor, /process\.argv\.slice\(2\)/)
  assert.match(supervisor, /job-worker\.ts/)
  assert.match(supervisor, /child\.kill\(signal\)/)
  assert.match(keepalive, /cron:\s*'\*\/10 \* \* \* \*'/)
  assert.match(keepalive, /actions\/checkout@[0-9a-f]{40}\s+# v4/)
  assert.match(keepalive, /actions\/setup-node@[0-9a-f]{40}\s+# v4[\s\S]*node-version:\s*24/)
  assert.match(keepalive, /node scripts\/check-production-health\.mjs https:\/\/mychat-nm6x\.onrender\.com\/api\/ready/)
  assert.match(healthVerifier, /payload\.status !== "ok"/)
  assert.match(healthVerifier, /payload\.ready !== true/)
  for (const check of ['auth', 'database', 'distributedRateLimit', 'queue', 'worker', 'stream', 'sandbox']) {
    assert.match(healthVerifier, new RegExp(`"${check}"`))
  }
})

test('runtime readiness is defined after and checks every scaling primitive', () => {
  const migration = read('supabase/migrations/20260713030000_runtime_scaling.sql')
  const triggerIndex = migration.indexOf('create trigger preserve_chat_generation_terminal_status')
  const healthIndex = migration.indexOf('create or replace function public.runtime_healthcheck()')

  assert.ok(triggerIndex >= 0)
  assert.ok(healthIndex > triggerIndex)
  assert.match(migration, /to_regclass\('public\.api_rate_limits'\)/)
  assert.match(migration, /to_regprocedure\('public\.consume_api_rate_limit\(text,integer,integer\)'\)/)
  assert.match(migration, /column_name = 'cancel_requested_at'/)
  assert.match(migration, /tgname = 'preserve_chat_generation_terminal_status'/)
  assert.match(migration, /has_function_privilege\([\s\S]*?'service_role'/)
})

test('rate-limit hotfix is additive, executable, and readiness-versioned', () => {
  const migration = read('supabase/migrations/20260713060000_rate_limit_timestamp_fix.sql')
  const rateLimitFunction = migration.slice(
    migration.indexOf('create or replace function public.consume_api_rate_limit'),
    migration.indexOf('comment on function public.consume_api_rate_limit'),
  )

  assert.match(rateLimitFunction, /v_now timestamptz := clock_timestamp\(\)/)
  assert.doesNotMatch(rateLimitFunction, /\bcurrent_time\b/i)
  assert.match(migration, /mychat\.rate_limit\.contract\.v2/)
  assert.match(migration, /create or replace function public\.runtime_healthcheck_v3\(\)/)
  assert.match(migration, /select public\.runtime_healthcheck_v2\(\)/)
  assert.match(migration, /grant execute on function public\.runtime_healthcheck_v3\(\)[\s\S]*to service_role/)
})
