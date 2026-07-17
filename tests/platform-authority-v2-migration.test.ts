import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const migration = readFileSync(new URL(
  '../supabase/migrations/20260717010000_platform_authority_v2.sql',
  import.meta.url,
), 'utf8')

test('platform authority v2 aligns Agent execution limits with the activated catalog', () => {
  const enqueue = migration.slice(
    migration.indexOf('create or replace function public.enqueue_agent_task_job'),
    migration.indexOf('-- One process heartbeat'),
  )
  assert.match(enqueue, /job_price_activation_heads[\s\S]*head\.sku = 'agent\.task'/)
  assert.match(enqueue, /'requestedTokenLimit', v_token_limit[\s\S]*'effectiveTokenLimit', v_token_limit/)
  assert.match(enqueue, /'tokenLimit', v_token_limit/)
  assert.doesNotMatch(enqueue, /'tokenLimit',\s*500000/)
  assert.match(enqueue, /grant execute[\s\S]*to service_role/)
  assert.doesNotMatch(enqueue, /grant execute[\s\S]*to authenticated/)
})

test('stream admission uses bounded O(1) counters without a global scan or advisory lock', () => {
  const acquire = migration.slice(
    migration.indexOf('create or replace function public.acquire_job_event_stream'),
    migration.indexOf('-- A chat turn is now one service-owned transaction'),
  )
  assert.match(migration, /create table if not exists public\.job_stream_capacity_counters/)
  assert.match(migration, /after insert or delete on public\.job_stream_leases/)
  assert.match(acquire, /job_stream_capacity_counters[\s\S]*for update/)
  assert.doesNotMatch(acquire, /pg_advisory_xact_lock/)
  assert.doesNotMatch(acquire, /count\(\*\)[\s\S]*from public\.job_stream_leases/)
  assert.match(acquire, /limit 64[\s\S]*for update skip locked/)
})

test('worker presence is process-scoped with exact per-queue capacities', () => {
  assert.match(migration, /add column if not exists queue_capacities jsonb/)
  assert.match(migration, /create or replace function public\.heartbeat_job_worker_v2/)
  assert.match(migration, /create or replace function public\.read_job_worker_readiness_v3/)
  assert.match(migration, /sum\(\(worker\.queue_capacities->>required_queue\)::integer\)/)
  assert.match(migration, /limit 100[\s\S]*for update skip locked/)
})

test('chat turn persistence and enqueue share one service-only transaction', () => {
  const chat = migration.slice(
    migration.indexOf('create or replace function public.enqueue_chat_turn_v1'),
    migration.indexOf('create or replace function public.enqueue_chat_regeneration_v1'),
  )
  assert.match(chat, /insert into public\.conversations/)
  assert.equal(chat.match(/insert into public\.messages/g)?.length, 2)
  assert.match(chat, /public\.enqueue_job\(/)
  assert.match(chat, /on conflict \(id\) do nothing/)
  assert.match(chat, /chat_turn_user_message_conflict/)
  assert.match(chat, /grant execute[\s\S]*to service_role/)
  assert.doesNotMatch(chat, /grant execute[\s\S]*to authenticated/)
})

test('chat regeneration is a fenced atomic branch replacement', () => {
  const regeneration = migration.slice(
    migration.indexOf('create or replace function public.enqueue_chat_regeneration_v1'),
    migration.indexOf('create or replace function public.runtime_healthcheck_v15'),
  )
  assert.match(regeneration, /idempotency_key = input_idempotency_key[\s\S]*for update/)
  assert.ok(
    regeneration.indexOf("'replayed', true")
      < regeneration.indexOf('chat_regeneration_stale_branch'),
  )
  assert.match(regeneration,
    /status in \('queued', 'leased', 'running', 'awaiting_input', 'cancelling'\)/)
  assert.match(regeneration, /v_tail\.id <> input_expected_tail_message_id/)
  assert.match(regeneration, /order by seq for update/)
  assert.match(regeneration, /insert into public\.generated_media_cleanup_jobs/)
  assert.match(regeneration, /delete from public\.messages[\s\S]*seq > v_source\.seq/)
  assert.match(regeneration, /update public\.messages[\s\S]*content_parts = jsonb_build_array/)
  assert.match(regeneration, /insert into public\.messages[\s\S]*public\.enqueue_job\(/)
  assert.match(regeneration, /grant execute[\s\S]*to service_role/)
  assert.doesNotMatch(regeneration, /grant execute[\s\S]*to authenticated/)
})

test('outbox acknowledges only topics with an owned delivery side effect', () => {
  assert.match(migration, /suppress_unconsumed_job_lifecycle_outbox/)
  for (const topic of ['jobs.ready', 'jobs.terminal', 'jobs.cancel_requested', 'jobs.poison']) {
    assert.match(migration, new RegExp(`'${topic.replace('.', '\\.')}'`))
  }
  assert.match(migration, /before insert on public\.job_outbox/)
  assert.match(migration, /delete from public\.job_outbox[\s\S]*status <> 'published'/)
})
