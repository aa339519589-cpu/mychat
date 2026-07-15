import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const migration = readFileSync(new URL(
  '../supabase/migrations/20260713200000_job_worker_heartbeats.sql',
  import.meta.url,
), 'utf8')

test('worker heartbeat migration installs private fenced presence records', () => {
  assert.match(migration, /create table if not exists public\.job_worker_heartbeats/)
  assert.match(migration, /alter table public\.job_worker_heartbeats enable row level security/)
  assert.match(migration, /revoke all on table public\.job_worker_heartbeats[\s\S]*service_role/)
  assert.match(migration, /create or replace function public\.heartbeat_job_worker/)
  assert.match(migration, /on conflict \(worker_id\) do update/)
  assert.match(migration, /create or replace function public\.mark_job_worker_draining/)
})

test('readiness requires bounded fresh coverage and a v6 schema contract', () => {
  assert.match(migration, /read_job_worker_readiness_v1/)
  assert.match(migration, /where not draining[\s\S]*heartbeat_at >= v_now - make_interval/)
  assert.match(migration, /'missingQueues'/)
  assert.match(migration, /'staleWorkers'/)
  assert.match(migration, /'freshestHeartbeatAgeSeconds'/)
  assert.match(migration, /'oldestActiveHeartbeatAgeSeconds'/)
  assert.match(migration, /'queues', queue_metrics/)
  assert.match(migration, /create or replace function public\.runtime_healthcheck_v6/)
  assert.match(migration, /grant execute on function public\.runtime_healthcheck_v6\(\)[\s\S]*service_role/)
})
