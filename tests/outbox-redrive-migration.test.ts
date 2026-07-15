import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const migration = readFileSync(new URL(
  '../supabase/migrations/20260713210000_job_outbox_redrive.sql',
  import.meta.url,
), 'utf8')

test('outbox redrive is bounded, fenced, idempotent, and service-only', () => {
  assert.match(migration, /add column if not exists replay_count integer not null default 0/)
  assert.match(migration, /add column if not exists max_redrives integer not null default 3/)
  assert.match(migration, /replay_count <= max_redrives/)
  assert.match(migration, /create unique index if not exists audit_log_job_outbox_redrive_request_unique/)
  assert.match(migration, /create or replace function public\.redrive_job_outbox/)
  assert.match(migration, /from public\.audit_log[\s\S]*?request_id = input_redrive_key/)
  assert.match(migration, /from public\.job_outbox[\s\S]*?for update/)
  assert.match(migration, /current_message\.last_redrive_key = input_redrive_key/)
  assert.match(migration, /current_message\.lock_version <> input_expected_lock_version/)
  assert.match(migration, /current_message\.status <> 'dead'/)
  assert.match(migration, /lock_version = lock_version \+ 1/)
  assert.match(migration, /and lock_version = input_expected_lock_version/)
  assert.match(migration, /and replay_count < max_redrives/)
  assert.match(migration, /revoke all on function public\.redrive_job_outbox[\s\S]*?service_role/)
  assert.match(migration, /grant execute on function public\.redrive_job_outbox[\s\S]*?to service_role/)
})

test('redrive state and its immutable audit record commit together', () => {
  assert.match(migration, /begin;[\s\S]*insert into public\.audit_log[\s\S]*commit;/)
  assert.match(migration, /'outbox\.redriven', 'job_outbox'/)
  assert.match(migration, /current_message\.job_id, input_redrive_key/)
  assert.match(migration, /'sourceLockVersion', input_expected_lock_version/)
  assert.match(migration, /'delaySeconds', input_delay_seconds/)
  assert.match(migration, /'previousAttempts', previous_attempts/)
})
