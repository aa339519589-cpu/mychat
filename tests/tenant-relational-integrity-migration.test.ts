import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const migration = readFileSync(new URL(
  '../supabase/migrations/20260713270000_tenant_relational_integrity.sql',
  import.meta.url,
), 'utf8')
const compact = migration.replace(/\s+/g, ' ').toLowerCase()

function assertTenantForeignKey(input: {
  child: string
  name: string
  childColumns: string[]
  parent: string
  parentColumns: string[]
  action: 'c' | 'n' | 'r'
  deleteColumns?: string[]
}) {
  const columns = (values: string[]) => `array[${values.map(value => `'${value}'`).join(', ')}]`
  const expected = `'public.${input.child}', '${input.name}', `
    + `${columns(input.childColumns)}, 'public.${input.parent}', `
    + `${columns(input.parentColumns)}, '${input.action}'`
    + (input.deleteColumns ? `, ${columns(input.deleteColumns)}` : '')
  assert.ok(compact.includes(expected), `missing or malformed tenant FK call: ${input.name}`)
}

test('tenant-owned core tables expose tenant-first candidate keys', () => {
  const tables = [
    'projects',
    'project_files',
    'project_memories',
    'conversations',
    'messages',
    'code_sessions',
    'code_messages',
    'conversation_chunks',
    'artifacts',
  ]

  for (const table of tables) {
    assert.match(
      compact,
      new RegExp(`create unique index concurrently if not exists ${table}_tenant_id_uidx on public\\.${table}\\(user_id, id\\)`),
      `${table} must have a stable (user_id, id) candidate key`,
    )
  }
  assert.match(compact, /messages_tenant_conversation_id_uidx on public\.messages\(user_id, conversation_id, id\)/)
  assert.match(compact, /jobs_principal_id_uidx on public\.jobs\(principal_id, id\)/)
})

test('product relationships prove tenant ownership and same-conversation identity', () => {
  assertTenantForeignKey({
    child: 'project_files', name: 'project_files_tenant_project_fkey',
    childColumns: ['user_id', 'project_id'], parent: 'projects',
    parentColumns: ['user_id', 'id'], action: 'c',
  })
  assertTenantForeignKey({
    child: 'messages', name: 'messages_tenant_conversation_fkey',
    childColumns: ['user_id', 'conversation_id'], parent: 'conversations',
    parentColumns: ['user_id', 'id'], action: 'c',
  })
  assertTenantForeignKey({
    child: 'conversations', name: 'conversations_tenant_summary_message_fkey',
    childColumns: ['user_id', 'id', 'summary_until_message_id'], parent: 'messages',
    parentColumns: ['user_id', 'conversation_id', 'id'], action: 'n',
    deleteColumns: ['summary_until_message_id'],
  })
  assertTenantForeignKey({
    child: 'conversation_chunks', name: 'conversation_chunks_tenant_message_start_fkey',
    childColumns: ['user_id', 'conversation_id', 'message_start_id'], parent: 'messages',
    parentColumns: ['user_id', 'conversation_id', 'id'], action: 'n',
    deleteColumns: ['message_start_id'],
  })
  assertTenantForeignKey({
    child: 'artifacts', name: 'artifacts_conversation_message_fkey',
    childColumns: ['user_id', 'conversation_id', 'message_id'], parent: 'messages',
    parentColumns: ['user_id', 'conversation_id', 'id'], action: 'c',
  })
  assertTenantForeignKey({
    child: 'chat_generations', name: 'chat_generations_tenant_assistant_message_fkey',
    childColumns: ['user_id', 'conversation_id', 'assistant_message_id'], parent: 'messages',
    parentColumns: ['user_id', 'conversation_id', 'id'], action: 'c',
  })
})

test('nullable ownership FKs clear only the relationship column', () => {
  for (const column of [
    'project_id',
    'summary_until_message_id',
    'message_start_id',
    'message_end_id',
    'generation_id',
    'step_id',
  ]) {
    assert.match(compact, new RegExp(`'n', array\\['${column}'\\]`))
  }
  assert.doesNotMatch(compact, /'n', array\['user_id'/)
  assert.doesNotMatch(compact, /'n', array\['principal_id'/)
})

test('Agent and Job children are bound to the same tenant as their authority row', () => {
  assertTenantForeignKey({
    child: 'agent_tool_calls', name: 'agent_tool_calls_tenant_task_step_fkey',
    childColumns: ['user_id', 'task_id', 'step_id'], parent: 'agent_task_steps',
    parentColumns: ['user_id', 'task_id', 'id'], action: 'n', deleteColumns: ['step_id'],
  })
  assertTenantForeignKey({
    child: 'agent_workspace_heads', name: 'agent_workspace_heads_tenant_job_fkey',
    childColumns: ['user_id', 'job_id'], parent: 'jobs',
    parentColumns: ['principal_id', 'id'], action: 'r',
  })
  assertTenantForeignKey({
    child: 'ledger_balance_settlements', name: 'ledger_balance_settlements_tenant_entry_fkey',
    childColumns: ['principal_id', 'ledger_entry_id'], parent: 'ledger_entries',
    parentColumns: ['principal_id', 'id'], action: 'r',
  })
  assertTenantForeignKey({
    child: 'jobs', name: 'jobs_tenant_confirmation_fkey',
    childColumns: ['principal_id', 'confirmation_id'], parent: 'agent_confirmation_gates',
    parentColumns: ['user_id', 'id'], action: 'r',
  })
  assert.match(compact, /'job_admission_reservations_tenant_job_fkey',[\s\S]*?null, true, true/)
})

test('migration is an online replay-safe expand that fails closed on poisoned index names', () => {
  assert.match(compact, /set lock_timeout = '5s'/)
  assert.match(compact, /set statement_timeout = '30min'/)
  assert.equal(
    compact.match(/\('[a-z_]+_uidx', 'public\.[a-z_]+'::regclass, array\[/g)?.length,
    20,
  )
  assert.match(compact, /declare unusable_indexes text/)
  assert.match(compact, /named_relation\.relnamespace = 'public'::regnamespace/)
  assert.match(compact, /or not indisunique/)
  assert.match(compact, /or not indisvalid/)
  assert.match(compact, /or not indisready/)
  assert.match(compact, /or not indislive/)
  assert.match(compact, /or indkey::text <> expected_attnums/)
  assert.match(compact, /tenant_candidate_index_unusable/)
  assert.match(compact, /drop index concurrently the unusable index/)
  assert.equal(compact.match(/create unique index concurrently if not exists/g)?.length, 20)
  assert.ok(
    compact.indexOf('declare unusable_indexes text')
      < compact.indexOf('create unique index concurrently if not exists'),
    'invalid-index preflight must run before the first concurrent index DDL',
  )
  assert.match(compact, /create or replace procedure pg_temp\.ensure_tenant_foreign_key/)
  assert.match(compact, /existing_constraint\.conkey <> child_attnums/)
  assert.match(compact, /existing_constraint\.confkey <> parent_attnums/)
  assert.match(compact, /existing_constraint\.confdelsetcols/)
  assert.equal(compact.match(/call pg_temp\.ensure_tenant_foreign_key/g)?.length, 35)
  assert.match(compact, /on delete %s%s not valid/)
  assert.match(compact, /validate constraint project_files_tenant_project_fkey/)
  assert.doesNotMatch(migration, /^\s*drop\s+index/im)
  assert.doesNotMatch(compact, /drop constraint/)
  assert.match(compact, /expand-only release: keep every legacy fk in parallel/)
  assert.match(compact, /production observation proves all writers use the composite/)
  assert.doesNotMatch(compact, /(?:^|;) begin;/)
  assert.doesNotMatch(compact, /commit;/)
  assert.doesNotMatch(migration, /^\s*delete\s+from\s+/im)
  assert.doesNotMatch(migration, /^\s*update\s+public\./im)

  assert.ok(
    compact.indexOf('validate constraint jobs_tenant_confirmation_fkey') >= 0,
    'every composite FK must validate during expand',
  )
  assert.match(compact, /reset statement_timeout; reset lock_timeout;\s*$/)
})
