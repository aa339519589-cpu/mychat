import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const migration = readFileSync(new URL(
  '../supabase/migrations/20260729010000_direct_chat_admission_v2.sql',
  import.meta.url,
), 'utf8')

test('direct chat admission v2 is one atomic service-only durable transaction', () => {
  const admission = migration.slice(
    migration.indexOf('create or replace function public.admit_chat_turn_v2'),
    migration.indexOf('create or replace function public.runtime_healthcheck_v16'),
  )
  assert.match(admission, /language plpgsql[\s\S]*security definer/)
  assert.match(admission, /insert into public\.conversations/)
  assert.equal(admission.match(/insert into public\.messages/g)?.length, 2)
  assert.match(admission, /public\.enqueue_job\(/)
  assert.ok(
    admission.indexOf('insert into public.messages')
      < admission.indexOf('public.enqueue_job('),
  )
  assert.match(admission, /update public\.conversations/)
  assert.match(admission, /drop function if exists public\.enqueue_chat_turn_v1/)
  assert.match(admission, /grant execute[\s\S]*to service_role/)
  assert.doesNotMatch(admission, /grant execute[\s\S]*to authenticated/)
})

test('runtime v16 requires the new function and rejects the obsolete RPC', () => {
  const runtime = migration.slice(
    migration.indexOf('create or replace function public.runtime_healthcheck_v16'),
  )
  assert.match(runtime, /select public\.runtime_healthcheck_v14\(\)/)
  assert.match(runtime, /to_regprocedure\([\s\S]*public\.admit_chat_turn_v2/)
  assert.match(runtime, /public\.enqueue_chat_turn_v1[\s\S]*\) is null/)
  assert.match(runtime, /not has_function_privilege\([\s\S]*'authenticated'/)
  assert.match(runtime, /not has_function_privilege\([\s\S]*'anon'/)
})
