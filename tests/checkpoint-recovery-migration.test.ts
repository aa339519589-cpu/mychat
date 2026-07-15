import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const migration = readFileSync(new URL(
  '../supabase/migrations/20260713180000_checkpoint_recovery_contract.sql',
  import.meta.url,
), 'utf8')

test('stale lease recovery requires the latest checkpoint to be resumable', () => {
  assert.match(migration, /create or replace function public\.claim_next_job/)
  assert.match(migration, /select checkpoint\.resumable[\s\S]*from public\.job_checkpoints as checkpoint/)
  assert.match(migration, /coalesce\([\s\S]*checkpoint\.resumable[\s\S]*\), true\)/)
  assert.match(migration, /not stale_recoverable[\s\S]*stale_lease_unrecoverable/)
  assert.match(migration, /for update skip locked/)
})

test('the patched claim RPC remains service-role-only', () => {
  assert.match(migration, /revoke all on function public\.claim_next_job\(text,text\[\],integer\)[\s\S]*authenticated/)
  assert.match(migration, /grant execute on function public\.claim_next_job\(text,text\[\],integer\)[\s\S]*service_role/)
})
