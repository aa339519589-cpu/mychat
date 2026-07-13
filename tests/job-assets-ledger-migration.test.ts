import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = new URL('../supabase/migrations/20260713090000_job_assets_and_ledger_quota.sql', import.meta.url)

test('asset receipts are fenced, canonicalized only by terminal CAS, and otherwise queued for cleanup', async () => {
  const sql = await readFile(migration, 'utf8')
  assert.match(sql, /create table if not exists public\.job_assets/)
  assert.match(sql, /create or replace function public\.record_job_asset/)
  assert.match(sql, /lease_owner is distinct from input_worker_id/)
  assert.match(sql, /lease_version <> input_lease_version/)
  assert.match(sql, /expected_prefix/)
  assert.match(sql, /state = 'canonical'/)
  assert.match(sql, /'assets\.cleanup'/)
  assert.match(sql, /grant execute on function public\.record_job_asset[\s\S]*to service_role/)
})

test('quota decisions are derived from the append-only ledger', async () => {
  const sql = await readFile(migration, 'utf8')
  assert.match(sql, /create or replace function public\.get_ledger_quota_status/)
  assert.match(sql, /from public\.ledger_entries where principal_id = input_principal_id/)
  assert.match(sql, /interval '5 hours'/)
  assert.match(sql, /interval '7 days'/)
  assert.match(sql, /grant execute on function public\.get_ledger_quota_status\(uuid\) to authenticated, service_role/)
  assert.match(sql, /commit;\s*$/)
})
