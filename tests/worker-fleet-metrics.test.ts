import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  WORKER_FLEET_QUEUES,
  WorkerFleetMetricsUnavailable,
  exportWorkerFleetMetrics,
  parseWorkerFleetMetrics,
  readWorkerFleetMetrics,
} from '../lib/observability/worker-fleet-metrics'

function snapshot() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-07-13T12:00:00.000Z',
    ready: true,
    activeWorkers: 2,
    totalCapacity: 8,
    staleWorkers: 1,
    drainingWorkers: 1,
    freshestHeartbeatAgeSeconds: 1.25,
    oldestActiveHeartbeatAgeSeconds: 4.5,
    requiredQueues: [...WORKER_FLEET_QUEUES],
    coveredQueues: [...WORKER_FLEET_QUEUES].reverse(),
    missingQueues: [] as string[],
    queues: [...WORKER_FLEET_QUEUES].reverse().map((queue, index) => ({
      queue,
      ready: true,
      activeWorkers: index % 2 + 1,
      totalCapacity: index % 2 + 3,
      freshestHeartbeatAgeSeconds: index + 0.25,
      workerId: 'must-never-render',
      revision: 'must-never-render',
    })),
  }
}

test('worker fleet parser closes labels and exporter renders database freshness', () => {
  const parsed = parseWorkerFleetMetrics(snapshot())
  assert.deepEqual(parsed.queues.map(sample => sample.queue), WORKER_FLEET_QUEUES)
  const output = exportWorkerFleetMetrics(
    parsed,
    new Date('2026-07-13T12:00:02.000Z'),
  )
  assert.match(output, /mychat_authoritative_worker_fleet_snapshot_age_seconds 2/)
  assert.match(output, /mychat_authoritative_worker_fleet_ready 1/)
  assert.match(output, /mychat_authoritative_worker_fleet_stale_workers 1/)
  assert.match(output, /mychat_authoritative_worker_queue_ready\{queue="outbox"\} 1/)
  assert.match(output, /mychat_authoritative_worker_queue_freshest_heartbeat_age_seconds\{queue="outbox"\} 2\.25/)
  assert.doesNotMatch(output, /must-never-render|worker_id|workerId|revision/)
})

test('worker fleet parser rejects unknown, duplicate, and inconsistent samples', () => {
  const unknown = snapshot()
  unknown.queues[0]!.queue = 'tenant-controlled' as 'chat'
  assert.throws(() => parseWorkerFleetMetrics(unknown), WorkerFleetMetricsUnavailable)

  const duplicate = snapshot()
  duplicate.queues[0]!.queue = duplicate.queues[1]!.queue
  assert.throws(() => parseWorkerFleetMetrics(duplicate), WorkerFleetMetricsUnavailable)

  const incomplete = snapshot()
  incomplete.missingQueues = ['outbox']
  assert.throws(() => parseWorkerFleetMetrics(incomplete), WorkerFleetMetricsUnavailable)

  const impossible = snapshot()
  impossible.queues[0]!.activeWorkers = 0
  assert.throws(() => parseWorkerFleetMetrics(impossible), WorkerFleetMetricsUnavailable)
})

test('worker fleet reader calls the bounded readiness RPC and fails closed', async () => {
  const calls: Array<{ name: string; args: unknown }> = []
  const client = {
    rpc: (name: string, args: unknown) => {
      calls.push({ name, args })
      return Promise.resolve({ data: snapshot(), error: null })
    },
  } as unknown as SupabaseClient
  const parsed = await readWorkerFleetMetrics({
    createAdminClient: () => client,
    rpcTimeoutMs: 100,
    maxAgeSeconds: 20,
    revision: 'abcdef012345',
  })
  assert.equal(parsed.ready, true)
  assert.deepEqual(calls, [{
    name: 'read_job_worker_readiness_v3',
    args: {
      input_required_queues: [...WORKER_FLEET_QUEUES],
      input_max_age_seconds: 20,
      input_revision: 'abcdef012345',
    },
  }])

  let invalidRevisionCalls = 0
  await assert.rejects(
    readWorkerFleetMetrics({
      revision: 'branch/main',
      createAdminClient: () => {
        invalidRevisionCalls++
        return client
      },
    }),
    WorkerFleetMetricsUnavailable,
  )
  assert.equal(invalidRevisionCalls, 0)

  await assert.rejects(
    readWorkerFleetMetrics({
      revision: 'abcdef012345',
      createAdminClient: () => null,
    }),
    WorkerFleetMetricsUnavailable,
  )
  await assert.rejects(
    readWorkerFleetMetrics({
      revision: 'abcdef012345',
      createAdminClient: () => ({
        rpc: async () => ({ data: null, error: { code: 'XX000' } }),
      }) as unknown as SupabaseClient,
    }),
    WorkerFleetMetricsUnavailable,
  )
  await assert.rejects(
    readWorkerFleetMetrics({
      revision: 'abcdef012345',
      createAdminClient: () => ({
        rpc: () => new Promise(() => undefined),
      }) as unknown as SupabaseClient,
      rpcTimeoutMs: 10,
    }),
    WorkerFleetMetricsUnavailable,
  )
})
