import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const sql = readFileSync(
  new URL('../supabase/migrations/20260713130000_agent_snapshot_cas.sql', import.meta.url),
  'utf8',
).toLowerCase()

test('snapshot migration installs a private immutable content-addressed store', () => {
  assert.match(sql, /'agent-snapshots',[\s\S]*false,[\s\S]*67108864/)
  assert.match(sql, /name ~ '\^\[\^\/\]\+\/\[\^\/\]\+\/blobs\/\[a-f0-9\]\{64\}\$'/)
  assert.match(sql, /before update or delete on public\.agent_artifacts/)
  assert.doesNotMatch(sql, /create policy "agent_snapshot_blobs_(?:update|delete)_own"/)
  assert.match(sql, /revoke all on function public\.reject_snapshot_manifest_update\(\)[\s\S]*authenticated/)
})
