import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  AuthoritativeJobMetricsUnavailable,
  exportAuthoritativeJobMetrics,
  parseAuthoritativeJobMetrics,
  readAuthoritativeJobMetrics,
} from '../lib/observability/authoritative-job-metrics'
import { JOB_METRIC_TYPES } from '../lib/observability/job-metrics'

const migration = new URL(
  '../supabase/migrations/20260713140000_authoritative_job_observability.sql',
  import.meta.url,
)
const metricsRoute = new URL('../app/api/metrics/route.ts', import.meta.url)
const metricsAuth = new URL('../lib/observability/metrics-auth.ts', import.meta.url)

function snapshot() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-07-13T12:00:00.000Z',
    windowSeconds: 3_600,
    jobTypes: [...JOB_METRIC_TYPES].reverse().map((jobType, index) => ({
      jobType: jobType as string,
      queueDepth: index,
      queueOldestAgeSeconds: index + 0.5,
      terminal: { completed: index + 1, failed: 1, cancelled: 0 },
      terminalTotal: { completed: index + 101, failed: 11, cancelled: 7 },
      leaseExpired: 0,
      retryWaiting: 1,
      poison: 0,
      enqueueStarted: { good: 9, eligible: 10, ratio: 0.9 },
      cancelTerminal: { good: 0, eligible: 0, ratio: null },
      principalId: 'must-never-render',
    })),
    outbox: {
      pending: 4,
      ready: 3,
      oldestReadyAgeSeconds: 12.5,
      expiredLeases: 1,
      retrying: 2,
      dead: 1,
    },
    assets: { cleanupPending: 3, cleanupDead: 1, cleanupOrphan: 2 },
  }
}

test('authoritative metrics parser enforces closed labels and renderer omits identifiers', () => {
  const parsed = parseAuthoritativeJobMetrics(snapshot())
  assert.deepEqual(parsed.jobTypes.map(sample => sample.jobType), JOB_METRIC_TYPES)
  const output = exportAuthoritativeJobMetrics(
    parsed,
    new Date('2026-07-13T12:00:01.500Z'),
  )
  assert.match(output, /mychat_authoritative_snapshot_age_seconds 1\.5/)
  assert.match(output, /mychat_authoritative_queue_depth\{job_type="chat_generation"\} 7/)
  assert.match(output, /mychat_authoritative_jobs_terminal_window\{job_type="agent_task",status="failed"\} 1/)
  assert.match(output, /# TYPE mychat_authoritative_jobs_terminal_total counter/)
  assert.match(output, /mychat_authoritative_jobs_terminal_total\{job_type="agent_task",status="completed"\} 105/)
  assert.match(output, /mychat_authoritative_asset_cleanup\{condition="orphan"\} 2/)
  assert.match(output, /mychat_authoritative_slo_window_ratio\{objective="cancel_terminal_3s",job_type="title"\} NaN/)
  assert.doesNotMatch(output, /must-never-render|principal_id|principalId|job_id|jobId|request_id/)
})

test('authoritative metrics reject unknown, duplicate, incomplete, and inconsistent samples', () => {
  const unknown = snapshot()
  unknown.jobTypes[0]!.jobType = 'tenant-controlled'
  assert.throws(() => parseAuthoritativeJobMetrics(unknown), AuthoritativeJobMetricsUnavailable)

  const duplicate = snapshot()
  duplicate.jobTypes[0]!.jobType = duplicate.jobTypes[1]!.jobType
  assert.throws(() => parseAuthoritativeJobMetrics(duplicate), AuthoritativeJobMetricsUnavailable)

  const inconsistent = snapshot()
  inconsistent.jobTypes[0]!.enqueueStarted = { good: 2, eligible: 1, ratio: 2 }
  assert.throws(() => parseAuthoritativeJobMetrics(inconsistent), AuthoritativeJobMetricsUnavailable)

  const missing = snapshot()
  missing.jobTypes.pop()
  assert.throws(() => parseAuthoritativeJobMetrics(missing), AuthoritativeJobMetricsUnavailable)
})

test('authoritative metrics reader calls the bounded RPC and fails closed', async () => {
  const calls: Array<{ name: string; args: unknown }> = []
  const client = {
    rpc: (name: string, args: unknown) => {
      calls.push({ name, args })
      return Promise.resolve({ data: snapshot(), error: null })
    },
  } as unknown as SupabaseClient
  const parsed = await readAuthoritativeJobMetrics({
    createAdminClient: () => client,
    rpcTimeoutMs: 100,
    windowSeconds: 3_600,
  })
  assert.equal(parsed.schemaVersion, 1)
  assert.deepEqual(calls, [{
    name: 'read_job_observability_v1',
    args: { input_window_seconds: 3_600 },
  }])

  await assert.rejects(
    readAuthoritativeJobMetrics({ createAdminClient: () => null }),
    AuthoritativeJobMetricsUnavailable,
  )
  await assert.rejects(
    readAuthoritativeJobMetrics({
      createAdminClient: () => ({
        rpc: async () => ({ data: null, error: { code: 'XX000' } }),
      }) as unknown as SupabaseClient,
    }),
    AuthoritativeJobMetricsUnavailable,
  )
  await assert.rejects(
    readAuthoritativeJobMetrics({
      createAdminClient: () => ({
        rpc: () => new Promise(() => undefined),
      }) as unknown as SupabaseClient,
      rpcTimeoutMs: 10,
    }),
    AuthoritativeJobMetricsUnavailable,
  )
  await assert.rejects(
    readAuthoritativeJobMetrics({ windowSeconds: 299 }),
    AuthoritativeJobMetricsUnavailable,
  )
})

test('observability migration and route preserve the privileged scrape boundary', async () => {
  const [sql, route, auth] = await Promise.all([
    readFile(migration, 'utf8'),
    readFile(metricsRoute, 'utf8'),
    readFile(metricsAuth, 'utf8'),
  ])
  assert.match(sql, /create or replace function public\.read_job_observability_v1/)
  assert.match(sql, /security definer[\s\S]*set statement_timeout = '8s'/)
  assert.match(sql, /input_window_seconds not between 300 and 86400/)
  assert.match(sql, /'chat_generation'::text[\s\S]*'other'::text/)
  assert.match(sql, /started_at <= created_at \+ interval '2 seconds'/)
  assert.match(sql, /terminal_at <= cancel_requested_at \+ interval '3 seconds'/)
  assert.match(sql, /cleanupOrphan[\s\S]*interval '15 minutes'/)
  assert.match(sql, /'cleanupPending'[\s\S]*asset\.state = 'deleting'[\s\S]*asset\.state in \('reserved', 'uploaded'\)[\s\S]*job\.status in \('completed', 'failed', 'cancelled'\)/)
  assert.match(sql, /create table if not exists public\.job_observability_terminal_counts/)
  assert.match(sql, /create trigger record_job_observability_terminal/)
  assert.match(sql, /revoke all on function public\.read_job_observability_v1\(integer\)[\s\S]*from public, anon, authenticated, service_role/)
  assert.match(sql, /grant execute on function public\.read_job_observability_v1\(integer\)[\s\S]*to service_role/)
  assert.doesNotMatch(sql, /'jobId'|'principalId'|'requestId'|'objectKey'/)

  assert.match(route, /metricsRequestAuthorized/)
  assert.match(auth, /timingSafeEqual/)
  assert.match(auth, /MINIMUM_SECRET_BYTES = 32/)
  assert.match(route, /status: 404/)
  assert.match(route, /readAuthoritativeJobMetrics/)
  assert.match(route, /readWorkerFleetMetrics/)
  assert.match(route, /readStreamLifecycleMetrics/)
  assert.match(route, /exportAuthoritativeJobMetrics\(authoritative\)[\s\S]*exportWorkerFleetMetrics\(workerFleet\)[\s\S]*exportStreamLifecycleMetrics\(lifecycle\)/)
  assert.doesNotMatch(route, /exportJobMetrics\(\)/)
  assert.match(route, /status: 503/)
  assert.match(route, /'Retry-After': '5'/)
})
