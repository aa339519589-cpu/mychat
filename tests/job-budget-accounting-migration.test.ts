import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const path = new URL('../supabase/migrations/20260713220000_job_budget_accounting.sql', import.meta.url)
const sql = readFileSync(path, 'utf8').toLowerCase()

test('budget accounting migration enforces bounded budgets and fenced attempt-ledger writes', () => {
  assert.match(sql, /create or replace function public\.assert_job_budget\(input_budget jsonb\)/)
  assert.match(sql, /create trigger jobs_validate_budget/)
  assert.match(sql, /create or replace function public\.record_job_accounting\(/)
  assert.match(sql, /for update/)
  assert.match(sql, /current_job\.lease_owner is distinct from input_worker_id/)
  assert.match(sql, /current_job\.lease_version <> input_lease_version/)
  assert.match(sql, /current_job\.attempt <> input_attempt/)
  assert.match(sql, /ledger_idempotency_conflict/)
  assert.match(sql, /all_existed/)
  assert.match(sql, /'recorded', all_existed, 'replayed', all_existed/)
})

test('claim contracts expose debit usage and accounting stays service-role only', () => {
  assert.match(sql, /create or replace function public\.job_contract_json/)
  for (const field of ['walltimems', 'rawtokens', 'weightedtokens', 'costmicros', 'sandboxtimems', 'toolcalls']) {
    assert.ok(sql.includes(`'${field}'`), `missing usage field ${field}`)
  }
  assert.match(sql, /entry\.direction = 'debit'/)
  assert.match(sql, /revoke all on function public\.record_job_accounting[\s\S]*from public, anon, authenticated, service_role/)
  assert.match(sql, /grant execute on function public\.record_job_accounting[\s\S]*to service_role/)
  assert.match(sql, /create or replace function public\.runtime_healthcheck_v7/)
})
