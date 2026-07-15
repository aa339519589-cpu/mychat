import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const migration = readFileSync(new URL(
  '../supabase/migrations/20260713300000_atomic_checkpoint_accounting.sql',
  import.meta.url,
), 'utf8')

test('atomic checkpoint migration binds recovery progress to immutable accounting', () => {
  assert.match(migration, /add column if not exists commit_key text/)
  assert.match(migration, /add constraint job_checkpoints_atomic_commit_shape_check/)
  assert.match(migration, /create or replace function public\.checkpoint_job_with_accounting/)
  assert.match(migration, /from public\.jobs where id = input_job_id for update/)
  assert.match(migration, /current_checkpoint\.version = input_expected_checkpoint_version \+ 1/)
  assert.match(migration, /checkpoint_idempotency_conflict/)
  assert.match(migration, /public\.record_job_accounting\([\s\S]*public\.checkpoint_job_primitive\(/)
  assert.match(migration, /raise exception 'atomic_checkpoint_commit_failed'/)
  assert.match(migration, /raise exception 'legacy_checkpoint_rpc_disabled'/)
})

test('runtime v14 requires the private atomic RPC and disables the legacy checkpoint path', () => {
  assert.match(migration, /create or replace function public\.runtime_healthcheck_v14/)
  const health = migration.slice(migration.indexOf('create or replace function public.runtime_healthcheck_v14'))
  assert.match(health, /select public\.runtime_healthcheck_v13\(\)/)
  assert.match(health, /checkpoint_job_with_accounting\(uuid,text,bigint,integer,bigint,text,text,jsonb,jsonb,boolean,text,jsonb\)/)
  assert.match(health, /not has_function_privilege\([\s\S]*?'authenticated'/)
  assert.match(health, /checkpoint_job_primitive\(uuid,text,bigint,text,jsonb,jsonb,boolean,text\)/)
  assert.match(health, /legacy_checkpoint_rpc_disabled/)
  assert.match(health, /job_checkpoints_atomic_commit_shape_check/)
})
