import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  exportStreamLifecycleMetrics,
  parseStreamLifecycleMetrics,
  readStreamLifecycleMetrics,
} from '../lib/observability/stream-lifecycle-metrics'

const generatedAt = '2026-07-14T00:00:00.000Z'
const sample = {
  schemaVersion: 1,
  generatedAt,
  activeStreams: 80,
  streamCapacity: 256,
  expiredStreamLeases: 1,
  expiredAdmissionReservations: 2,
  retainedPayloads: 7,
  overduePayloads: 2,
  payloadCleanupDeadLetters: 0,
  outboxGcEligible: 12,
  tenantsNearResourceLimit: 3,
} as const

test('stream lifecycle metrics reject inconsistent capacity and payload samples', () => {
  assert.deepEqual(parseStreamLifecycleMetrics(sample), sample)
  assert.throws(() => parseStreamLifecycleMetrics({ ...sample, activeStreams: 257 }))
  assert.throws(() => parseStreamLifecycleMetrics({ ...sample, overduePayloads: 8 }))
  assert.throws(() => parseStreamLifecycleMetrics({ ...sample, principalId: 'forbidden' }))
})

test('stream lifecycle metrics read the authoritative RPC and export bounded labels', async () => {
  let rpcName = ''
  const client = {
    rpc: async (name: string) => {
      rpcName = name
      return { data: sample, error: null }
    },
  } as unknown as SupabaseClient
  const metrics = await readStreamLifecycleMetrics({ createAdminClient: () => client })
  assert.equal(rpcName, 'read_stream_lifecycle_metrics_v1')
  const output = exportStreamLifecycleMetrics(metrics, new Date('2026-07-14T00:00:05.000Z'))
  assert.match(output, /mychat_authoritative_lifecycle_snapshot_age_seconds 5/)
  assert.match(output, /mychat_authoritative_lifecycle_active_streams 80/)
  assert.match(output, /mychat_authoritative_lifecycle_overdue_payloads 2/)
  assert.match(output, /mychat_authoritative_lifecycle_expired_admission_reservations 2/)
  assert.doesNotMatch(output, /principal|job_id|object_key/)
})

test('stream lifecycle metrics fail closed without database authority', async () => {
  await assert.rejects(readStreamLifecycleMetrics({ createAdminClient: () => null }))
})

test('stream lifecycle metrics abort a timed-out PostgREST request', async () => {
  let aborted = false
  const pending = new Promise<{ data: unknown; error: unknown }>(() => undefined)
  const request = Object.assign(pending, {
    abortSignal(signal: AbortSignal) {
      signal.addEventListener('abort', () => { aborted = true }, { once: true })
      return pending
    },
  })
  const client = { rpc: () => request } as unknown as SupabaseClient
  await assert.rejects(readStreamLifecycleMetrics({
    createAdminClient: () => client,
    rpcTimeoutMs: 1,
  }))
  assert.equal(aborted, true)
})
