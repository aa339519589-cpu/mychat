import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migrationPath = new URL('../supabase/migrations/20260713040000_generation_leases.sql', import.meta.url)
const contractPath = new URL('../supabase/migrations/20260713050000_generation_lease_contract.sql', import.meta.url)

test('generation lease migration is fenced, ownership checked, and replay safe', async () => {
  const sql = await readFile(migrationPath, 'utf8')
  const claim = sql.slice(
    sql.indexOf('create or replace function public.claim_chat_generation'),
    sql.indexOf('create or replace function public.renew_chat_generation_lease'),
  )
  const progress = sql.slice(
    sql.indexOf('create or replace function public.write_chat_generation_progress'),
    sql.indexOf('create or replace function public.finalize_chat_generation'),
  )
  const finalize = sql.slice(
    sql.indexOf('create or replace function public.finalize_chat_generation'),
    sql.indexOf('create or replace function public.cancel_chat_generation'),
  )

  assert.match(sql, /add column if not exists lease_owner uuid/)
  assert.match(sql, /add column if not exists lease_version bigint not null default 0/)
  assert.match(sql, /add column if not exists media jsonb not null default '\[\]'::jsonb/)
  assert.match(sql, /chat_generations_media_terminal_check/)
  assert.match(sql, /where id = 'generated-media'[\s\S]*file_size_limit, 0\) >= 10485760/)
  assert.doesNotMatch(claim, /auth\.uid\(\)/)
  assert.match(claim, /from public\.conversations\s+where id = input_conversation_id and user_id = input_user_id/)
  assert.match(claim, /from public\.messages[\s\S]*id = input_assistant_message_id/)
  assert.match(claim, /user_id = input_user_id/)
  assert.match(claim, /conversation_id = input_conversation_id/)
  assert.match(claim, /role = 'assistant'/)
  assert.match(claim, /for key share/)
  assert.match(claim, /'reason', 'identity_mismatch'/)
  assert.match(sql, /chat_generations_assistant_message_fkey[\s\S]*references public\.messages\(id\)[\s\S]*not valid/)
  assert.match(sql, /validate constraint chat_generations_assistant_message_fkey/)
  assert.match(sql, /chat_generations_assistant_message_key unique \(assistant_message_id\)/)
  assert.match(sql, /chat_generations_one_active_conversation_idx[\s\S]*where status in \('queued', 'running'\)/)
  assert.match(claim, /on conflict do nothing/)
  assert.match(claim, /'reason', 'assistant_conflict'/)
  assert.match(claim, /'reason', 'conversation_active'/)
  assert.match(claim, /for update/)
  assert.match(claim, /set status = 'failed'/)
  assert.match(claim, /error = 'stale_generation_lease_expired'/)
  assert.match(claim, /'reason', 'stale'/)
  assert.doesNotMatch(claim, /set status = 'running',[\s\S]*lease_version = greatest/)

  for (const fencedMutation of [progress, finalize]) {
    assert.match(fencedMutation, /lease_owner = input_runner_id/)
    assert.match(fencedMutation, /lease_version = input_lease_version/)
    assert.match(fencedMutation, /lease_expires_at > clock_timestamp\(\)/)
  }
  assert.match(finalize, /status = 'running'/)
  assert.match(finalize, /input_status = 'cancelled' or cancel_requested_at is null/)
  assert.match(finalize, /input_media jsonb default '\[\]'::jsonb/)
  assert.match(finalize, /media = terminal_media/)
  assert.match(finalize, /'generated_media', current_generation\.media,[\s\S]*'generation', jsonb_build_object\(/)
  assert.match(finalize, /'id', current_generation\.id[\s\S]*'status', current_generation\.status[\s\S]*'sequence', current_generation\.sequence[\s\S]*'error', current_generation\.error/)
  assert.match(finalize, /update public\.conversations[\s\S]*set updated_at = clock_timestamp\(\)/)
  assert.doesNotMatch(sql, /revoke insert, update, delete on table public\.chat_generations from authenticated/)
  assert.match(sql, /create or replace function public\.fail_stale_chat_generation/)
  assert.match(sql, /create or replace function public\.runtime_healthcheck_v2\(\)/)
  assert.match(sql, /lease_expires_at is null or lease_expires_at <= clock_timestamp\(\)/)
  assert.match(sql, /renew_chat_generation_lease[\s\S]*lease_expires_at > clock_timestamp\(\)/)
  assert.match(sql, /create or replace function public\.preserve_terminal_generation_message\(\)/)
  assert.match(sql, /create or replace function public\.reject_active_generation_message_delete\(\)/)
  assert.match(sql, /create table if not exists public\.generated_media_cleanup_jobs/)
  assert.match(sql, /create or replace function public\.delete_messages_with_media_cleanup/)
  assert.match(sql, /create or replace function public\.delete_conversation_with_media_cleanup/)
  assert.match(sql, /delete_messages_with_media_cleanup[\s\S]*from public\.conversations[\s\S]*for update/)
  assert.match(sql, /insert into public\.generated_media_cleanup_jobs[\s\S]*delete from public\.messages/)
  assert.match(sql, /delete_conversation_with_media_cleanup[\s\S]*insert into public\.generated_media_cleanup_jobs[\s\S]*delete from public\.conversations/)
  assert.match(sql, /and convalidated/)
  assert.match(sql, /stored_object\.bucket_id = 'generated-media'/)
  assert.match(sql, /count\(distinct \(item->>'type'\) \|\| ':' \|\| \(item->>'url'\)\)/)
  for (const rpc of [
    'claim_chat_generation\\(uuid,uuid,uuid,uuid,uuid,integer\\)',
    'renew_chat_generation_lease\\(uuid,uuid,uuid,bigint,integer\\)',
    'write_chat_generation_progress\\(uuid,uuid,uuid,bigint,text,text,integer\\)',
    'finalize_chat_generation\\(uuid,uuid,uuid,bigint,text,text,text,integer,text,jsonb\\)',
    'cancel_chat_generation\\(uuid,uuid\\)',
    'fail_stale_chat_generation\\(uuid,uuid\\)',
    'delete_messages_with_media_cleanup\\(uuid,uuid\\[\\],text\\[\\]\\)',
    'delete_conversation_with_media_cleanup\\(uuid,uuid,text\\[\\]\\)',
  ]) {
    assert.match(sql, new RegExp(`has_function_privilege\\([\\s\\S]*?'service_role'[\\s\\S]*?${rpc}[\\s\\S]*?'EXECUTE'`))
    assert.match(sql, new RegExp(`not has_function_privilege\\([\\s\\S]*?'authenticated'[\\s\\S]*?${rpc}[\\s\\S]*?'EXECUTE'`))
  }
})

test('lease migrations use expand-contract ordering without breaking old instances', async () => {
  const [expand, contract] = await Promise.all([
    readFile(migrationPath, 'utf8'),
    readFile(contractPath, 'utf8'),
  ])
  assert.match(expand, /^--[\s\S]*?begin;/)
  assert.match(expand, /commit;\s*$/)
  assert.doesNotMatch(expand, /revoke insert, update, delete on table public\.chat_generations/)

  assert.match(contract, /^--[\s\S]*?begin;/)
  assert.match(contract, /revoke insert, update, delete on table public\.chat_generations from public, authenticated, anon/)
  for (const column of [
    'id', 'user_id', 'conversation_id', 'assistant_message_id',
    'status', 'content', 'thinking', 'sequence', 'error',
    'lease_owner', 'lease_expires_at', 'lease_version', 'cancel_requested_at',
    'media', 'created_at', 'updated_at',
  ]) {
    assert.match(contract, new RegExp(`revoke update \\([\\s\\S]*?\\b${column}\\b[\\s\\S]*?\\) on table public\\.chat_generations from public, authenticated, anon`))
    assert.match(contract, new RegExp(`from unnest\\(array\\[[\\s\\S]*?'${column}'[\\s\\S]*?\\]\\) as writable_column`))
  }
  assert.match(contract, /create or replace function public\.runtime_healthcheck_v2\(\)/)
  assert.match(contract, /not has_table_privilege\('authenticated', 'public\.chat_generations', 'INSERT'\)/)
  assert.match(contract, /not has_table_privilege\('authenticated', 'public\.chat_generations', 'UPDATE'\)/)
  assert.match(contract, /not has_table_privilege\('authenticated', 'public\.chat_generations', 'DELETE'\)/)
  assert.match(contract, /has_column_privilege\([\s\S]*?'authenticated'[\s\S]*?writable_column\.column_name[\s\S]*?'UPDATE'/)
  assert.match(contract, /not has_any_column_privilege\([\s\S]*?'authenticated'[\s\S]*?'UPDATE'/)
  for (const trigger of [
    'preserve_chat_generation_terminal_status',
    'preserve_terminal_generation_message',
    'reject_active_generation_message_delete',
  ]) {
    assert.match(contract, new RegExp(`tgname = '${trigger}'[\\s\\S]*?tgenabled <> 'D'`))
  }
  assert.match(contract, /revoke select on table public\.chat_generations from public, authenticated, anon/)
  assert.match(contract, /grant select \([\s\S]*status,[\s\S]*content,[\s\S]*\) on table public\.chat_generations to authenticated/)
  assert.match(contract, /grant select \([\s\S]*media,[\s\S]*\) on table public\.chat_generations to authenticated/)
  assert.match(contract, /not has_column_privilege\([\s\S]*'authenticated',[\s\S]*'lease_owner',[\s\S]*'SELECT'/)
  assert.match(contract, /not has_column_privilege\([\s\S]*'authenticated',[\s\S]*'lease_version',[\s\S]*'SELECT'/)
  assert.match(contract, /revoke delete on table public\.messages from public, authenticated, anon/)
  assert.match(contract, /revoke delete on table public\.conversations from public, authenticated, anon/)
  assert.doesNotMatch(contract.match(/grant select \([\s\S]*?\) on table public\.chat_generations/)?.[0] ?? '', /lease_owner|lease_version/)
  for (const policy of [
    'generated_media_upload_own',
    'generated_media_update_own',
    'generated_media_delete_own',
  ]) {
    assert.match(contract, new RegExp(`drop policy if exists "${policy}" on storage\\.objects`))
  }
  assert.match(contract, /not exists \([\s\S]*from pg_catalog\.pg_policies[\s\S]*generated_media_upload_own/)
  assert.match(contract, /commit;\s*$/)
})
