import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { BillingReconciliationMonitor } from '../lib/jobs/billing-reconciliation'

test('billing reconciliation monitor refreshes the authoritative snapshot', async () => {
  const calls: string[] = []
  const client = {
    rpc: async (name: string) => {
      calls.push(name)
      return { data: {
        schemaVersion: 1,
        healthy: true,
        releaseReady: false,
        totalMismatches: 0,
        releaseBlockers: 3,
      }, error: null }
    },
  } as unknown as SupabaseClient
  const monitor = new BillingReconciliationMonitor({ createAdminClient: () => client })
  assert.deepEqual(await monitor.runOnce(), {
    healthy: true,
    releaseReady: false,
    totalMismatches: 0,
    releaseBlockers: 3,
  })
  assert.deepEqual(calls, ['refresh_billing_reconciliation_v1'])
})

test('billing reconciliation monitor rejects malformed authority responses', async () => {
  const client = {
    rpc: async () => ({ data: { healthy: true }, error: null }),
  } as unknown as SupabaseClient
  const monitor = new BillingReconciliationMonitor({ createAdminClient: () => client })
  await assert.rejects(monitor.runOnce(), /malformed/)
})

test('billing reconciliation monitor bounds a stalled refresh', async () => {
  const client = {
    rpc: async () => new Promise(() => undefined),
  } as unknown as SupabaseClient
  const monitor = new BillingReconciliationMonitor({
    createAdminClient: () => client,
    rpcTimeoutMs: 1_000,
  })
  await assert.rejects(monitor.runOnce(), /timed out/)
})
