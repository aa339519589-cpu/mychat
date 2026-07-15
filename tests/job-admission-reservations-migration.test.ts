import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const migration = new URL(
  '../supabase/migrations/20260713240000_admission_and_reservations.sql',
  import.meta.url,
)
const sql = readFileSync(migration, 'utf8').toLowerCase()

test('job admission atomically reserves maximum cost and settles terminal usage', () => {
  assert.match(sql, /create table if not exists public\.job_price_catalog/)
  assert.match(sql, /create table if not exists public\.job_admission_reservations/)
  assert.match(sql, /foreign key \(job_id\)[\s\S]*deferrable initially deferred/)
  assert.match(sql, /create trigger jobs_reserve_admission[\s\S]*before insert on public\.jobs/)
  assert.match(sql, /from public\.profiles where user_id = new\.principal_id for update/)
  assert.match(sql, /if v_balance < v_reserve_tokens/)
  assert.match(sql, /balance = v_balance - v_reserve_tokens/)
  assert.match(sql, /create trigger jobs_settle_admission/)
  assert.match(sql, /v_actual_tokens > v_reservation\.reserved_tokens/)
  assert.match(sql, /balance = v_balance \+ v_release/)
  assert.match(sql, /create or replace function public\.release_job_admission_reservation/)
})

test('browser roles cannot enqueue Agent work or mutate worker-owned run state', () => {
  for (const signature of [
    'enqueue_agent_task_job',
    'enqueue_agent_operation',
    'merge_agent_task_meta',
    'merge_agent_run_state',
  ]) {
    assert.match(sql, new RegExp(`revoke all on function public\\.${signature}`))
  }
  for (const signature of ['claim_agent_run', 'renew_agent_run', 'release_agent_run']) {
    assert.match(sql, new RegExp(`public\\.${signature}\\(uuid,text`))
  }
  assert.match(sql, /if to_regprocedure\(v_signature\) is not null/)
  assert.match(sql, /grant execute on function public\.enqueue_agent_task_job[\s\S]*to service_role/)
  assert.match(sql, /grant execute on function public\.enqueue_agent_operation[\s\S]*to service_role/)
  assert.doesNotMatch(sql, /grant execute on function public\.enqueue_agent_task_job[\s\S]*to authenticated/)
})

test('reservation-aware ledger settlement cannot double-debit held credit', () => {
  assert.match(sql, /create or replace function public\.settle_ledger_balance_debit/)
  assert.match(sql, /from public\.job_admission_reservations[\s\S]*where job_id = new\.job_id/)
  assert.match(sql, /if v_reservation\.funding = 'balance'/)
  assert.match(sql, /debited_tokens, remaining_balance[\s\S]*new\.weighted_tokens, 0, v_balance/)
})

test('server routes use command authority after browser Agent enqueue is revoked', async () => {
  const fs = await import('node:fs/promises')
  const [chatRoute, applyRoute, operation] = await Promise.all([
    '../app/api/code/chat/route.ts',
    '../app/api/code/apply/route.ts',
    '../lib/code-agent/operation-enqueue.ts',
  ].map(path => fs.readFile(new URL(path, import.meta.url), 'utf8')))
  assert.match(chatRoute, /createAdminClient\(\)[\s\S]*commandClient\.rpc\('enqueue_agent_task_job'/)
  assert.match(applyRoute, /createAdminClient\(\)[\s\S]*commandClient/)
  assert.match(operation, /commandClient\.rpc\('enqueue_agent_operation'/)
})
