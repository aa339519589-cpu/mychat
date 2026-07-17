import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const migration = readFileSync(new URL(
  '../supabase/migrations/20260713280000_revision_scoped_worker_readiness.sql',
  import.meta.url,
), 'utf8')
const workerEntrypoint = readFileSync(new URL('../job-worker.ts', import.meta.url), 'utf8')

test('worker readiness v2 scopes every fleet calculation to one validated revision', () => {
  assert.match(migration, /create index if not exists job_worker_heartbeats_revision_state_idx/)
  assert.match(migration, /create or replace function public\.read_job_worker_readiness_v2\([\s\S]*?input_revision text/)
  assert.match(migration, /coalesce\(input_revision, ''\) !~ '\^\(unknown\|\[0-9a-f\]\{7,64\}\)\$'/)
  assert.match(migration, /from public\.job_worker_heartbeats[\s\S]*?where revision = input_revision[\s\S]*?and not draining/)
  assert.match(migration, /from public\.job_worker_heartbeats\s+where revision = input_revision/)
  assert.match(migration, /from public\.job_worker_heartbeats as worker[\s\S]*?where worker\.revision = input_revision/)
  assert.match(migration, /'totalCapacity', total_capacity/)
  assert.match(migration, /'queues', queue_metrics/)
})

test('v12 directly gates terminal projection and every validated tenant relationship', () => {
  assert.match(migration, /create or replace function public\.runtime_healthcheck_v12\(\)/)
  assert.match(migration, /select public\.runtime_healthcheck_v11\(\)/)
  assert.match(migration, /to_regprocedure\([\s\S]*read_job_worker_readiness_v2\(text\[\],integer,text\)/)
  assert.match(migration, /projector\.oid = to_regprocedure\('public\.project_job_terminal\(\)'\)/)
  assert.match(migration, /terminal_trigger\.tgname = 'jobs_project_terminal'/)
  assert.match(migration, /terminal_trigger\.tgenabled in \('O', 'A'\)/)
  assert.match(migration, /installed_constraint\.contype = 'f'/)
  assert.match(migration, /cardinality\(installed_constraint\.conkey\) >= 2/)
  assert.match(migration, /installed_constraint\.convalidated/)
  assert.equal(
    migration.match(/\('public\.[^']+'::regclass, '[^']+_fkey'\)/g)?.length,
    35,
  )
})

test('v12 exposes only private revision-aware readiness authority', () => {
  assert.match(migration, /revoke all on function public\.read_job_worker_readiness_v2[\s\S]*?service_role/)
  assert.match(migration, /grant execute on function public\.read_job_worker_readiness_v2[\s\S]*?to service_role/)
  assert.match(migration, /revoke all on function public\.runtime_healthcheck_v12[\s\S]*?service_role/)
  assert.match(migration, /commit;\s*$/)
})

test('worker entrypoint advertises one process heartbeat with exact per-queue capacities', () => {
  assert.match(workerEntrypoint, /const heartbeat = new JobWorkerHeartbeat/)
  assert.match(workerEntrypoint, /workerId: baseWorkerId/)
  assert.match(workerEntrypoint, /queueCapacities: Object\.fromEntries\(\[/)
  assert.match(workerEntrypoint, /\.\.\.workerSpecs\.map\(spec => \[spec\.queue, spec\.concurrency\] as const\)/)
  assert.match(workerEntrypoint, /\['outbox', 1\] as const/)
  assert.match(workerEntrypoint, /startedAt: workerStartedAt/)
  assert.match(workerEntrypoint, /queues: \[spec\.queue\]/)
  assert.match(workerEntrypoint, /concurrency: spec\.concurrency/)
  assert.match(workerEntrypoint, /Promise\.all\(\[[\s\S]*?heartbeat\.run\(shutdown\.signal\)/)
  assert.match(workerEntrypoint, /billingReconciliation\.run\(shutdown\.signal\)/)
  assert.doesNotMatch(workerEntrypoint, /const heartbeatSpecs = \[/)
  assert.doesNotMatch(workerEntrypoint, /\.\.\.heartbeats\.map/)
})
