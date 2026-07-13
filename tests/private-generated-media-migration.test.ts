import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = new URL(
  '../supabase/migrations/20260713110000_private_generated_media.sql',
  import.meta.url,
)

test('generated media is private and direct browser policies are removed', async () => {
  const sql = await readFile(migration, 'utf8')
  assert.match(sql, /update storage\.buckets[\s\S]*set public = false/)
  assert.match(sql, /drop policy if exists "generated_media_public_read"/)
  assert.match(sql, /drop policy if exists "generated_media_upload_own"/)
  assert.match(sql, /create or replace function public\.reconcile_history_job_asset_cleanup/)
  assert.match(sql, /current_asset\.job_id::text \|\| ':assets\.cleanup:history'/)
  assert.match(sql, /state = 'deleted', canonical_at = null/)
  assert.match(sql, /create or replace function public\.runtime_healthcheck_v5\(\)/)
  assert.match(sql, /where id = 'generated-media' and public = false/)
  assert.match(sql, /not exists \([\s\S]*from pg_catalog\.pg_policies/)
  assert.match(sql, /grant execute on function public\.runtime_healthcheck_v5\(\)[\s\S]*to service_role/)
  assert.match(sql, /commit;\s*$/)
})
