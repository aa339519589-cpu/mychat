import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@/lib/supabase/types'
import { withAdmissionReconciliation } from '../lib/jobs/admission-reconciliation'
import { directAdmissionError } from '../lib/chat/direct-turn-admission'

const stale = { code: '55000', message: 'billing_reconciliation_unhealthy' }
const snapshot = (healthy: boolean) => ({ data: { schemaVersion: 1, healthy,
  releaseReady: healthy, totalMismatches: healthy ? 0 : 1, releaseBlockers: healthy ? 0 : 1 }, error: null })

test('warm admission performs no reconciliation RPC', async () => {
  const client = { rpc: () => { throw new Error('unexpected refresh') } } as unknown as SupabaseClient
  const receipt = { data: { id: 'original' }, error: null }
  assert.equal(await withAdmissionReconciliation(client, async () => receipt), receipt)
})

test('stale cold-start admission refreshes authority and replays the same operation once', async () => {
  const calls: string[] = []
  const client = { rpc: async (name: string) => { calls.push(name); return snapshot(true) } } as unknown as SupabaseClient
  let admissions = 0
  const result = await withAdmissionReconciliation(client, async () => {
    calls.push('admit:original-command')
    return ++admissions === 1 ? { data: null, error: stale } : { data: { id: 'original' }, error: null }
  })
  assert.equal(result.error, null)
  assert.deepEqual(calls, ['admit:original-command', 'refresh_billing_reconciliation_v1', 'admit:original-command'])
})

test('genuinely inconsistent balances remain blocked and transient, never bypassed', async () => {
  const client = { rpc: async () => snapshot(false) } as unknown as SupabaseClient
  let admissions = 0
  assert.deepEqual(await withAdmissionReconciliation(client, async () => {
    admissions += 1
    return { data: null, error: stale }
  }), { data: null, error: stale })
  assert.equal(admissions, 1)
  assert.equal(directAdmissionError(stale).code, 'JOB_DEPENDENCY_UNAVAILABLE')
  assert.equal(directAdmissionError(stale).retryable, true)
  assert.equal(directAdmissionError({ code: '55000', message: 'unrelated_permanent_conflict' }).retryable, false)
})

test('concurrent cold admissions share one refresh instead of taking the SQL refresh lock twice', async () => {
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  let refreshes = 0
  const client = { rpc: async () => { refreshes += 1; await waiting; return snapshot(true) } } as unknown as SupabaseClient
  const operation = () => { let calls = 0; return async () => ++calls === 1
    ? { data: null, error: stale } : { data: 'accepted', error: null } }
  const first = withAdmissionReconciliation(client, operation())
  const second = withAdmissionReconciliation(client, operation())
  await new Promise(resolve => setImmediate(resolve))
  release()
  const results = await Promise.all([first, second])
  assert.equal(refreshes, 1)
  assert.ok(results.every(result => result.error === null))
})

test('unrelated RPC errors are not replayed', async () => {
  const client = { rpc: () => { throw new Error('unexpected refresh') } } as unknown as SupabaseClient
  const receipt = { data: null, error: { code: '23505', message: 'conflict' } }
  assert.equal(await withAdmissionReconciliation(client, async () => receipt), receipt)
})
