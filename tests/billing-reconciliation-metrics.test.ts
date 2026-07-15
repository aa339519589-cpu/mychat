import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  exportBillingReconciliationMetrics,
  parseBillingReconciliationMetrics,
  readBillingReconciliationMetrics,
} from '../lib/observability/billing-reconciliation-metrics'

const snapshot = {
  schemaVersion: 1 as const,
  generation: 7,
  generatedAt: '2026-07-14T12:00:00.000Z',
  healthy: true,
  releaseReady: false,
  releaseBlockers: 2,
  totalMismatches: 0,
  newJobsWithoutReservations: 0,
  activeLegacyJobs: 2,
  terminalHeldReservations: 0,
  quoteMismatches: 0,
  movementEquationMismatches: 0,
  ledgerReceiptMismatches: 0,
  profileBalanceMismatches: 0,
  catalogActivationMismatches: 0,
  heldBalanceTokens: 1234,
}

test('billing reconciliation parser verifies totals without exporting identities', () => {
  assert.deepEqual(parseBillingReconciliationMetrics(snapshot), snapshot)
  assert.throws(() => parseBillingReconciliationMetrics({
    ...snapshot,
    totalMismatches: 1,
  }))
  assert.throws(() => parseBillingReconciliationMetrics({
    ...snapshot,
    jobId: 'secret',
  }))
})

test('billing reconciliation exporter exposes bounded release gates', () => {
  const output = exportBillingReconciliationMetrics(snapshot, Date.parse(snapshot.generatedAt) + 5_000)
  assert.match(output, /mychat_authoritative_billing_snapshot_age_seconds 5/)
  assert.match(output, /mychat_authoritative_billing_healthy 1/)
  assert.match(output, /mychat_authoritative_billing_release_ready 0/)
  assert.match(output, /mychat_authoritative_billing_release_blockers 2/)
  assert.match(output, /mychat_authoritative_billing_held_balance_tokens 1234/)
  assert.doesNotMatch(output, /principal_id=|job_id=|ledger_entry_id=|sku=/)
})

test('billing reconciliation reader fails closed on malformed snapshots', async () => {
  const good = {
    rpc: async () => ({ data: snapshot, error: null }),
  } as unknown as SupabaseClient
  assert.deepEqual(await readBillingReconciliationMetrics({
    createAdminClient: () => good,
  }), snapshot)

  const malformed = {
    rpc: async () => ({ data: { healthy: true }, error: null }),
  } as unknown as SupabaseClient
  await assert.rejects(readBillingReconciliationMetrics({
    createAdminClient: () => malformed,
  }))
})

test('billing reconciliation metrics abort a timed-out PostgREST request', async () => {
  let aborted = false
  const pending = new Promise<{ data: unknown; error: unknown }>(() => undefined)
  const request = Object.assign(pending, {
    abortSignal(signal: AbortSignal) {
      signal.addEventListener('abort', () => { aborted = true }, { once: true })
      return pending
    },
  })
  const client = { rpc: () => request } as unknown as SupabaseClient
  await assert.rejects(readBillingReconciliationMetrics({
    createAdminClient: () => client,
    rpcTimeoutMs: 1,
  }))
  assert.equal(aborted, true)
})
