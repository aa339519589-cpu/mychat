import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { JobLifecycleSweeper } from '../lib/jobs/lifecycle-sweeper'

test('lifecycle sweeper requests a bounded database batch and validates counters', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args })
      return { data: {
        outboxDeleted: 17,
        streamLeasesDeleted: 3,
        expiredReservationsReclaimed: 2,
      }, error: null }
    },
  } as unknown as SupabaseClient
  const sweeper = new JobLifecycleSweeper({
    createAdminClient: () => client,
    batchSize: 250,
  })
  assert.deepEqual(await sweeper.runOnce(), {
    outboxDeleted: 17,
    streamLeasesDeleted: 3,
    expiredReservationsReclaimed: 2,
  })
  assert.deepEqual(calls, [{
    name: 'sweep_job_lifecycle',
    args: { input_batch_size: 250 },
  }])
})

test('lifecycle sweeper fails closed on malformed authority responses', async () => {
  const client = {
    rpc: async () => ({ data: { outboxDeleted: -1 }, error: null }),
  } as unknown as SupabaseClient
  const sweeper = new JobLifecycleSweeper({ createAdminClient: () => client })
  await assert.rejects(sweeper.runOnce(), /malformed/)
})
