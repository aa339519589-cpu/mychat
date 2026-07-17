import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { JobWorkerHeartbeat } from '../lib/jobs/worker-heartbeat'

test('worker heartbeat publishes queue coverage then marks the process draining', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const shutdown = new AbortController()
  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args })
      return {
        data: name === 'heartbeat_job_worker_v2'
          ? { accepted: true, draining: false }
          : { accepted: true, draining: true },
        error: null,
      }
    },
  } as unknown as SupabaseClient
  const heartbeat = new JobWorkerHeartbeat({
    workerId: 'host:123:worker',
    revision: 'abcdef012345',
    queueCapacities: { chat: 2, media: 1, title: 1, agent: 1, outbox: 1 },
    intervalMs: 100,
    createClient: () => client,
    sleep: async () => { shutdown.abort() },
  })

  await heartbeat.run(shutdown.signal)
  assert.equal(calls.length, 2)
  assert.equal(calls[0]?.name, 'heartbeat_job_worker_v2')
  assert.deepEqual(calls[0]?.args.input_queue_capacities, {
    chat: 2, media: 1, title: 1, agent: 1, outbox: 1,
  })
  assert.equal(calls[1]?.name, 'mark_job_worker_draining')
})

test('worker heartbeat validates identity, revision, queues, and capacity', () => {
  const valid = {
    workerId: 'worker-1', revision: 'unknown', queueCapacities: { chat: 1 },
  }
  assert.throws(() => new JobWorkerHeartbeat({ ...valid, revision: 'branch/main' }))
  assert.throws(() => new JobWorkerHeartbeat({ ...valid, queueCapacities: {} }))
  assert.throws(() => new JobWorkerHeartbeat({ ...valid, queueCapacities: { 'Bad Queue': 1 } }))
  assert.throws(() => new JobWorkerHeartbeat({ ...valid, queueCapacities: { chat: 0 } }))
})

test('a transient heartbeat outage does not crash the worker loop', async () => {
  let calls = 0
  const shutdown = new AbortController()
  const client = {
    rpc: async (name: string) => {
      calls++
      if (name === 'heartbeat_job_worker_v2') throw new Error('database offline')
      return { data: { accepted: true }, error: null }
    },
  } as unknown as SupabaseClient
  const heartbeat = new JobWorkerHeartbeat({
    workerId: 'worker-1', revision: 'unknown', queueCapacities: { chat: 1 },
    intervalMs: 100,
    createClient: () => client,
    sleep: async () => { shutdown.abort() },
  })

  await heartbeat.run(shutdown.signal)
  assert.equal(calls, 2)
})

test('maintenance heartbeat advertises draining and never claims readiness', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const shutdown = new AbortController()
  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args })
      return { data: { accepted: true, draining: true }, error: null }
    },
  } as unknown as SupabaseClient
  const heartbeat = new JobWorkerHeartbeat({
    workerId: 'worker-draining', revision: 'unknown', queueCapacities: { chat: 1 },
    draining: true, intervalMs: 100, createClient: () => client,
    sleep: async () => { shutdown.abort() },
  })

  await heartbeat.run(shutdown.signal)
  assert.equal(calls[0]?.name, 'heartbeat_job_worker_v2')
  assert.equal(calls[0]?.args.input_draining, true)
  assert.equal(calls[1]?.name, 'mark_job_worker_draining')
})
