import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = new URL(
  '../supabase/migrations/20260713100000_job_outbox_dispatch.sql',
  import.meta.url,
)

test('outbox delivery uses versioned leases, bounded attempts, and service-only RPCs', async () => {
  const sql = await readFile(migration, 'utf8')
  assert.match(sql, /add column if not exists lock_version bigint not null default 0/)
  assert.match(sql, /add column if not exists max_attempts integer not null default 10/)
  assert.match(sql, /for update skip locked/)
  assert.match(sql, /lock_version = lock_version \+ 1/)
  assert.match(sql, /current_message\.lock_version <> input_lock_version/)
  assert.match(sql, /create or replace function public\.renew_job_outbox/)
  assert.match(sql, /attempts >= current_message\.max_attempts/)
  assert.match(sql, /revoke all on table public\.job_outbox, public\.job_assets from service_role/)
  assert.match(sql, /grant execute on function public\.claim_job_outbox[\s\S]*to service_role/)
})

test('asset cleanup is terminal-only and cannot select canonical assets', async () => {
  const sql = await readFile(migration, 'utf8')
  assert.match(sql, /create or replace function public\.prepare_job_asset_cleanup/)
  assert.match(sql, /status in \('completed', 'failed', 'cancelled'\)/)
  assert.match(sql, /state in \('reserved', 'uploaded'\)/)
  assert.match(sql, /and state = 'deleting'/)
  assert.doesNotMatch(sql, /state in \('reserved', 'uploaded', 'canonical'\)/)
  assert.match(sql, /foreign key \(job_id, principal_id\) references public\.jobs\(id, principal_id\)/)
  assert.match(sql, /commit;\s*$/)
})
