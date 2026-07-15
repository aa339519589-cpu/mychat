import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const admission = readFileSync(new URL(
  '../supabase/migrations/20260713240000_admission_and_reservations.sql',
  import.meta.url,
), 'utf8')
const migration = readFileSync(new URL(
  '../supabase/migrations/20260713290000_billing_reconciliation_contract.sql',
  import.meta.url,
), 'utf8')

test('price versions and activation history are append-only and replay-safe', () => {
  assert.match(admission, /on conflict \(sku, version\) do nothing/)
  assert.match(admission, /job_price_catalog_seed_conflict/)
  assert.doesNotMatch(admission, /on conflict \(sku, version\) do update/)
  assert.match(migration, /create table if not exists public\.job_price_activations/)
  assert.match(migration, /create table if not exists public\.job_price_activation_heads/)
  assert.match(migration, /job_price_catalog_is_append_only/)
  assert.match(migration, /job_price_activation_must_move_forward/)
  assert.match(migration, /on conflict \(sku\) do update set/)
  assert.match(migration, /head\.activation_generation \+ 1/)
  assert.match(migration, /observed\.change_token <> requested_token/)
  assert.doesNotMatch(migration, /pg_advisory_xact_lock\(hashtextextended\(new\.sku/)
})

test('reservation evidence stores a canonical quote and immutable hash', () => {
  assert.match(migration, /add column if not exists price_quote jsonb/)
  assert.match(migration, /add column if not exists price_quote_hash text/)
  assert.match(migration, /digest\(convert_to\(input_quote::text, 'UTF8'\), 'sha256'\)/)
  assert.match(migration, /hashAlgorithm', 'sha256-jsonb-text-pg16'/)
  assert.match(migration, /job_admission_quote_is_immutable/)
  assert.match(migration, /price_quote_hash = public\.job_price_quote_hash\(price_quote\)/)
  assert.match(migration, /price_quote \?& array/)
  assert.match(migration, /price_quote is distinct from public\.build_job_price_quote_v2/)
})

test('balance receipts prove hold equals debit minus credit plus release', () => {
  assert.match(migration, /create table if not exists public\.job_balance_movements/)
  assert.match(migration, /kind text not null check \(kind in \('hold', 'debit', 'credit', 'release'\)\)/)
  assert.match(migration, /movement_held <> movement_debited - movement_credited \+ movement_released/)
  assert.match(migration, /debited - credited > reserved_tokens/)
  assert.match(migration, /job_admission_credit_over_reversal/)
  assert.match(migration, /new\.job_id, new\.principal_id, new\.id, new\.direction/)
  assert.match(migration, /profile_balance_journal_delta_check/)
})

test('new Jobs cannot bypass reservation settlement through the legacy path', () => {
  assert.match(migration, /add column if not exists billing_contract_version smallint/)
  assert.match(migration, /new_job_requires_billing_contract_v2/)
  assert.match(migration, /job_reservation_required_for_terminal/)
  assert.match(migration, /job_reservation_required_for_ledger/)
  assert.match(migration, /create constraint trigger jobs_settle_admission/)
  assert.match(migration, /deferrable initially deferred/)
  assert.match(migration, /revoke all on function public\.record_quota_usage\(bigint,boolean\)/)
})

test('reconciliation is precomputed with a bounded refresh and constant-time health gate', () => {
  assert.match(migration, /create table if not exists public\.billing_reconciliation_snapshots/)
  assert.match(migration, /create or replace function public\.compute_billing_reconciliation_v1/)
  assert.match(migration, /set statement_timeout = '3s'/)
  assert.match(migration, /create or replace function public\.refresh_billing_reconciliation_v1/)
  assert.match(migration, /pg_try_advisory_xact_lock/)
  assert.match(migration, /create or replace function public\.runtime_healthcheck_v13/)
  const health = migration.slice(migration.indexOf('create or replace function public.runtime_healthcheck_v13'))
  assert.match(health, /billing_reconciliation_snapshots/)
  assert.match(health, /'releaseReady', true/)
  assert.match(health, /'releaseBlockers', 0/)
  assert.match(health, /and healthy/)
  assert.doesNotMatch(health, /compute_billing_reconciliation_v1\(\)/)
})
