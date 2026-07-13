import assert from 'node:assert/strict'
import test from 'node:test'
import { JobMetrics } from '../lib/observability/job-metrics'

test('job metrics aggregate bounded counters, gauges, and histograms', () => {
  const metrics = new JobMetrics()
  metrics.recordEnqueued('chat_generation')
  metrics.recordEnqueued('chat_generation')
  metrics.recordClaim('chat_generation', 'claimed')
  metrics.recordLeaseExpiration('chat_generation')
  metrics.recordTerminal('chat_generation', 'completed')
  metrics.recordProviderError('chat_generation', 'llm', true)
  metrics.setQueueState('chat_generation', 4, 2_500)
  metrics.observeQueueLatency('chat_generation', 250)
  metrics.observeQueueLatency('chat_generation', 750)
  metrics.observeRunDuration('chat_generation', 'completed', 1_500)

  const snapshot = metrics.snapshot(new Date('2026-07-13T12:00:00.000Z'))
  assert.equal(snapshot.schema_version, '1')
  assert.equal(snapshot.generated_at, '2026-07-13T12:00:00.000Z')
  assert.deepEqual(snapshot.counters.jobs_enqueued_total, [
    { job_type: 'chat_generation', value: 2 },
  ])
  assert.deepEqual(snapshot.gauges.queue_depth, [
    { job_type: 'chat_generation', value: 4 },
  ])
  assert.deepEqual(snapshot.gauges.queue_oldest_age_seconds, [
    { job_type: 'chat_generation', value: 2.5 },
  ])

  const latency = snapshot.histograms.job_queue_latency_seconds[0]
  assert.equal(latency?.count, 2)
  assert.equal(latency?.sum_seconds, 1)
  assert.equal(latency?.buckets.find(bucket => bucket.le === 0.25)?.count, 1)
  assert.equal(latency?.buckets.find(bucket => bucket.le === 1)?.count, 2)
  assert.equal(latency?.buckets.at(-1)?.le, '+Inf')
})

test('Prometheus export is deterministic and contains no high-cardinality dimensions', () => {
  const metrics = new JobMetrics()
  metrics.recordClaim('agent_task', 'contended')
  metrics.recordProviderError('agent_task', 'github', false)
  metrics.observeRunDuration('agent_task', 'failed', 2_500)

  const output = metrics.exportPrometheus()
  assert.match(output, /# TYPE mychat_job_claims_total counter/)
  assert.match(output, /mychat_job_claims_total\{job_type="agent_task",outcome="contended"\} 1/)
  assert.match(output, /mychat_provider_errors_total\{job_type="agent_task",provider_category="github",retryable="false"\} 1/)
  assert.match(output, /mychat_job_run_duration_seconds_bucket\{job_type="agent_task",status="failed",le="5"\} 1/)
  assert.doesNotMatch(output, /user_id|job_id|provider_name|request_id/)
})

test('job metrics reject unbounded labels and malformed observations at runtime', () => {
  const metrics = new JobMetrics()
  assert.throws(
    () => metrics.recordEnqueued('user-controlled-job-id' as 'other'),
    /bounded metric label/,
  )
  assert.throws(
    () => metrics.recordProviderError('tool', 'provider-account-123' as 'other', true),
    /bounded metric label/,
  )
  assert.throws(() => metrics.setQueueState('cleanup', -1, 0), /non-negative/)
  assert.throws(() => metrics.setQueueState('cleanup', 1.5, 0), /safe integer/)
  assert.throws(() => metrics.observeQueueLatency('cleanup', Number.NaN), /non-negative/)
})
