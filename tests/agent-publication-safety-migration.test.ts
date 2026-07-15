import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const migration = readFileSync(new URL(
  '../supabase/migrations/20260713190000_agent_publication_safety.sql',
  import.meta.url,
), 'utf8')

test('database rejects sensitive initial-repository paths and contents', () => {
  assert.match(migration, /new\.type <> 'agent\.operation'/)
  assert.match(migration, /initial_repository/)
  assert.match(migration, /agent_operation_sensitive_path/)
  assert.match(migration, /agent_operation_secret_content/)
  assert.match(migration, /PRIVATE KEY/)
  assert.match(migration, /gh\[po\]_/)
  assert.match(migration, /before insert or update of type, payload on public\.jobs/)
})

test('publication safety trigger cannot be invoked by browser or service roles', () => {
  assert.match(migration, /revoke all on function public\.enforce_agent_operation_publication_safety\(\)[\s\S]*authenticated, service_role/)
})
