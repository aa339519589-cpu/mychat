import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = new URL(
  '../supabase/migrations/20260713260000_stream_and_asset_lifecycle.sql',
  import.meta.url,
)

test('stream admission quotas are exact, expiring, and service-role-only', async () => {
  const sql = await readFile(migration, 'utf8')
  assert.match(sql, /create table if not exists public\.job_stream_leases/)
  assert.match(sql, /pg_advisory_xact_lock\(5720260713260000\)/)
  assert.match(sql, /global_count >= 256 or principal_count >= 4 or address_count >= 12 or job_count >= 2/)
  assert.match(sql, /hard_expires_at <= acquired_at \+ interval '15 minutes'/)
  assert.match(sql, /revoke all on function public\.acquire_job_event_stream[\s\S]*?authenticated, service_role/)
  assert.match(sql, /grant execute on function public\.acquire_job_event_stream[\s\S]*?to service_role/)
})

test('payload cleanup is fenced, delayed, tombstoned, and garbage-collected in bounded batches', async () => {
  const sql = await readFile(migration, 'utf8')
  assert.match(sql, /create table if not exists public\.job_payload_assets/)
  assert.match(sql, /'payloads\.cleanup'/)
  assert.match(sql, /current_message\.lock_version <> input_lock_version/)
  assert.match(sql, /state = 'deleted', deleted_at = v_now/)
  assert.match(sql, /where status = 'published' and published_at < input_published_before/)
  assert.match(sql, /reservation\.status = 'held' and reservation\.expires_at <= v_now/)
  assert.match(sql, /job\.lease_expires_at is null[\s\S]*?job\.lease_expires_at <= v_now/)
  assert.match(sql, /error_code = 'JOB_ADMISSION_EXPIRED'/)
  assert.match(sql, /limit input_batch_size[\s\S]*?for update skip locked/)
  assert.match(sql, /file_size_limit = 8388608/)
})

test('tenant resource accounting enforces row and aggregate byte limits at the database boundary', async () => {
  const sql = await readFile(migration, 'utf8')
  assert.match(sql, /create table if not exists public\.tenant_resource_usage/)
  assert.match(sql, /project_file_bytes[\s\S]*?<= 67108864/)
  assert.match(sql, /message_bytes[\s\S]*?<= 1073741824/)
  assert.match(sql, /payload_bytes[\s\S]*?<= 536870912/)
  assert.match(sql, /or input_project_file_bytes <= 0/)
  assert.match(sql, /new_bytes > 1048576/)
  assert.match(sql, /new_bytes > 2097152/)
  assert.match(sql, /coalesce\(new\.images, 'null'::jsonb\)::text/)
  assert.match(sql, /payload_bytes not between 2 and 8388608/)
  assert.match(sql, /runtime_healthcheck_v11/)
  assert.match(sql, /read_stream_lifecycle_metrics_v1/)
  assert.match(sql, /commit;\s*$/)
})

test('rolling cutover installs old-writer boundaries before backfill and reconciles last', async () => {
  const sql = await readFile(migration, 'utf8')
  const backfill = sql.indexOf('-- Existing payload references are admitted')
  const projectTrigger = sql.indexOf('create trigger track_project_file_resource_usage')
  const messageTrigger = sql.indexOf('create trigger track_message_resource_usage')
  const jobTrigger = sql.indexOf('create trigger register_job_payload_asset')
  const payloadTrigger = sql.indexOf('create trigger track_job_payload_resource_usage')
  const reconciliation = sql.indexOf('with source_principals as (')
  assert.ok(backfill > 0)
  assert.ok(projectTrigger > 0 && projectTrigger < backfill)
  assert.ok(messageTrigger > 0 && messageTrigger < backfill)
  assert.ok(jobTrigger > 0 && jobTrigger < backfill)
  assert.ok(payloadTrigger > backfill)
  assert.ok(reconciliation > payloadTrigger)
  assert.match(sql, /on conflict \(principal_id\) do update set[\s\S]*?payload_bytes = excluded\.payload_bytes/)
})
