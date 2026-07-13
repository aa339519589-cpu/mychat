import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migrationPath = new URL(
  '../supabase/migrations/20260713070000_unified_job_control_plane.sql',
  import.meta.url,
)

function functionBody(sql: string, name: string, nextName?: string): string {
  const start = sql.indexOf(`create or replace function public.${name}`)
  assert.notEqual(start, -1, `${name} must exist`)
  const end = nextName
    ? sql.indexOf(`create or replace function public.${nextName}`, start + 1)
    : sql.length
  assert.notEqual(end, -1, `${nextName} must follow ${name}`)
  return sql.slice(start, end)
}

test('unified job migration installs the complete durable control plane', async () => {
  const sql = await readFile(migrationPath, 'utf8')

  assert.match(sql, /^--[\s\S]*?begin;/)
  assert.match(sql, /commit;\s*$/)
  for (const table of [
    'jobs',
    'job_events',
    'job_checkpoints',
    'job_tool_effects',
    'job_outbox',
    'ledger_entries',
    'audit_log',
  ]) {
    assert.match(sql, new RegExp(`create table if not exists public\\.${table} \\(`))
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`))
  }

  assert.match(sql, /status text not null default 'queued' check \(status in \([\s\S]*'awaiting_input'[\s\S]*'cancelled'/)
  assert.match(sql, /lease_version bigint not null default 0 check \(lease_version >= 0\)/)
  assert.match(sql, /jobs_principal_idempotency_key_idx/)
  assert.match(sql, /jobs_one_active_chat_conversation_idx/)
  assert.match(sql, /jobs_one_active_chat_title_idx/)
  assert.match(sql, /jobs_one_active_agent_task_idx/)
  assert.match(sql, /unique \(job_id, seq\)/)
  assert.match(sql, /job_events_idempotency_idx/)
  assert.match(sql, /unique \(principal_id, effect_key\)/)
  assert.match(sql, /unique \(principal_id, idempotency_key\)/)
  assert.match(sql, /job_events_append_only/)
  assert.match(sql, /ledger_entries_append_only/)
  assert.match(sql, /audit_log_append_only/)
  assert.match(sql, /'job-payloads', 'job-payloads', false, 50331648/)
  assert.match(sql, /payloadRef descriptor/)
  assert.match(sql, /invalid_job_payload_reference/)
  assert.match(sql, /payloadRef'->>'objectKey'/)
  assert.match(sql, /payloadRef'->>'sha256'/)
  assert.match(sql, /where bucket_id = 'job-payloads'[\s\S]*name = payload_ref_name/)
  assert.match(sql, /create trigger protect_job_payload_objects/)

  for (const rpc of [
    'enqueue_job',
    'claim_next_job',
    'renew_job_lease',
    'retry_job',
    'append_job_events',
    'checkpoint_job',
    'record_job_tool_effect',
    'finalize_job',
    'cancel_job',
  ]) {
    assert.match(sql, new RegExp(`create or replace function public\\.${rpc}\\(`))
  }
  assert.match(sql, /create or replace function public\.runtime_healthcheck_v4\(\)/)
  assert.match(sql, /select public\.runtime_healthcheck_v3\(\)/)
})

test('worker writes are lease-fenced and terminal state has one CAS winner', async () => {
  const sql = await readFile(migrationPath, 'utf8')
  const claim = functionBody(sql, 'claim_next_job', 'renew_job_lease')
  const renew = functionBody(sql, 'renew_job_lease', 'retry_job')
  const retry = functionBody(sql, 'retry_job', 'append_job_events')
  const append = functionBody(sql, 'append_job_events', 'mirror_chat_job_progress')
  const checkpoint = functionBody(sql, 'checkpoint_job', 'record_job_tool_effect')
  const effect = functionBody(sql, 'record_job_tool_effect', 'finalize_job')
  const finalize = functionBody(sql, 'finalize_job', 'cancel_job')
  const cancel = functionBody(sql, 'cancel_job', 'runtime_healthcheck_v4')

  assert.match(claim, /for update skip locked/)
  assert.match(claim, /active\.principal_id = candidate\.principal_id/)
  assert.match(claim, /active\.lease_expires_at > v_now/)
  assert.match(claim, /lease_version = lease_version \+ 1/)
  assert.match(claim, /attempt = attempt \+ 1/)
  assert.match(claim, /job_tool_effects[\s\S]*not replay_safe/)
  assert.match(claim, /stale_lease_unrecoverable/)
  assert.match(retry, /status = 'queued'/)
  assert.match(retry, /'job\.retry_scheduled'/)
  assert.match(retry, /'unsafe_effect'/)
  assert.match(retry, /not replay_safe/)
  assert.match(retry, /insert into public\.job_outbox/)

  for (const fenced of [renew, retry, append, checkpoint, effect, finalize]) {
    assert.match(fenced, /lease_owner is distinct from input_worker_id|lease_owner = input_worker_id/)
    assert.match(fenced, /lease_version (?:<>|=) input_lease_version/)
    assert.match(fenced, /lease_expires_at (?:is null|>)|lease_expires_at <= v_now/)
  }

  assert.match(finalize, /for update/)
  assert.match(finalize, /status in \('completed', 'failed', 'cancelled'\)/)
  assert.match(finalize, /'replayed', true/)
  assert.match(finalize, /cancel_requested_at is not null[\s\S]*not irreversible_committed/)
  assert.match(finalize, /insert into public\.job_events/)
  assert.match(finalize, /insert into public\.ledger_entries/)
  assert.match(finalize, /insert into public\.job_outbox/)
  assert.match(finalize, /coalesce\(outbox_item->>'topic', outbox_item->>'kind'\)/)
  assert.match(finalize, /current_job\.id::text \|\| ':outbox:'/)
  assert.match(finalize, /ledger_idempotency_conflict/)
  assert.match(append, /job_event_idempotency_conflict/)
  assert.match(append, /'appended', true, 'replayed', true/)
  assert.match(cancel, /for update/)
  assert.match(cancel, /set status = 'cancelling'/)
  assert.match(cancel, /set status = 'cancelled'/)
  assert.match(sql, /terminal_job_immutable/)
})

test('chat enqueue and message projection are identity-locked and replayable', async () => {
  const sql = await readFile(migrationPath, 'utf8')
  const enqueue = functionBody(sql, 'enqueue_job', 'mirror_chat_job_terminal')
  const messageTrigger = functionBody(
    sql,
    'enforce_message_sor_contract',
    'enforce_job_state_contract',
  )

  for (const identity of ['conversationId', 'assistantMessageId', 'userMessageId']) {
    assert.match(enqueue, new RegExp(identity))
  }
  assert.match(enqueue, /from public\.conversations[\s\S]*user_id = input_principal_id/)
  assert.match(enqueue, /role = 'user'[\s\S]*for key share/)
  assert.match(enqueue, /role = 'assistant'[\s\S]*generation_id is null[\s\S]*for update/)
  assert.match(enqueue, /input_type = 'chat\.generation'/)
  assert.match(enqueue, /input_type = 'chat\.title'[\s\S]*chat_title_parent_not_found/)
  assert.match(enqueue, /input_type = 'agent\.task'[\s\S]*agent_job_task_not_found/)
  assert.match(enqueue, /outputKind'[\s\S]*\('text', 'image', 'video'\)/)
  assert.match(enqueue, /insert into public\.chat_generations/)
  assert.match(enqueue, /set generation_id = current_job\.id,[\s\S]*status = 'streaming'/)
  assert.match(enqueue, /'replayed', true/)

  assert.match(sql, /add column if not exists seq bigint/)
  assert.match(sql, /messages_conversation_seq_idx/)
  assert.match(messageTrigger, /from public\.conversations[\s\S]*for update/)
  assert.match(messageTrigger, /coalesce\(max\(message\.seq\), 0\) \+ 1/)
  assert.match(messageTrigger, /message_identity_immutable/)
  assert.match(messageTrigger, /generated_message_service_owned/)
  assert.match(messageTrigger, /terminal_message_immutable/)
  assert.match(sql, /content_parts jsonb not null default '\[\]'::jsonb/)
  assert.match(sql, /thinking_parts jsonb not null default '\[\]'::jsonb/)
  assert.match(sql, /media_refs jsonb not null default '\[\]'::jsonb/)
})

test('all control-plane mutations are service-role-only', async () => {
  const sql = await readFile(migrationPath, 'utf8')
  const signatures = [
    'enqueue_job\\([\\s\\S]*?timestamptz\\)',
    'claim_next_job\\(text,text\\[\\],integer\\)',
    'renew_job_lease\\(uuid,text,bigint,integer\\)',
    'retry_job\\(uuid,text,bigint,text,text,integer\\)',
    'append_job_events\\(uuid,text,bigint,jsonb\\)',
    'checkpoint_job\\([\\s\\S]*?boolean,text\\)',
    'record_job_tool_effect\\([\\s\\S]*?boolean,jsonb\\)',
    'finalize_job\\([\\s\\S]*?jsonb,jsonb\\)',
    'cancel_job\\(uuid,uuid,text\\)',
  ]
  for (const signature of signatures) {
    assert.match(
      sql,
      new RegExp(`revoke all on function public\\.${signature}[\\s\\S]*?from public, anon, authenticated`),
    )
    assert.match(
      sql,
      new RegExp(`grant execute on function public\\.${signature}[\\s\\S]*?to service_role`),
    )
  }
  assert.match(sql, /revoke all on table public\.jobs,[\s\S]*from public, anon, authenticated, service_role/)
  assert.match(sql, /create policy jobs_select_own[\s\S]*principal_id = auth\.uid\(\)/)
  assert.match(sql, /not has_table_privilege\('authenticated', 'public\.jobs', 'UPDATE'\)/)
  assert.match(sql, /not has_function_privilege\([\s\S]*'authenticated'[\s\S]*'public\.finalize_job/)
})
