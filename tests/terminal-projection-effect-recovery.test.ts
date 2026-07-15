import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const migration = readFileSync(new URL(
  '../supabase/migrations/20260713250000_terminal_projection_and_effect_recovery.sql',
  import.meta.url,
), 'utf8')

test('all Agent terminal transitions use one strict task and message projector', () => {
  assert.match(migration, /create or replace function public\.project_job_terminal\(\)/)
  assert.match(migration, /new\.type not in \('agent\.task', 'agent\.operation'\)/)
  assert.match(migration, /update public\.agent_tasks[\s\S]*get diagnostics projected_rows = row_count/)
  assert.match(migration, /update public\.code_messages[\s\S]*agent_terminal_message_projection_missing/)
  assert.match(migration, /drop trigger if exists jobs_project_agent_operation_terminal/)
  assert.match(migration, /after update of status on public\.jobs/)
})

test('only explicitly replay-safe failed effects can return to reserved', () => {
  assert.match(migration, /retrying_failed_effect := current_effect\.status = 'failed'[\s\S]*input_status = 'reserved'/)
  assert.match(migration, /current_effect\.replay_safe and coalesce\(input_replay_safe, false\)/)
  assert.match(migration, /failed_effect_not_replay_safe/)
  assert.match(migration, /when retrying_failed_effect then input_result_ref/)
  assert.match(migration, /grant execute on function public\.record_job_tool_effect[\s\S]*to service_role/)
})
