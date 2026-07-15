import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const root = process.cwd()
const alerts = readFileSync(resolve(root, 'ops/prometheus/alerts.yml'), 'utf8')
const dashboardText = readFileSync(
  resolve(root, 'ops/grafana/job-control-plane-dashboard.json'),
  'utf8',
)

test('Prometheus rules cover worker, queue, failure, cancellation, lease, and outbox risks', () => {
  for (const alert of [
    'MyChatMetricsSnapshotStale',
    'MyChatWorkerFleetNotReady',
    'MyChatWorkerHeartbeatStale',
    'MyChatQueueOldestAgeHigh',
    'MyChatJobFailureRatioHigh',
    'MyChatCancellationSLOBurn',
    'MyChatLeaseRecoveryStalled',
    'MyChatOutboxDeadLetter',
    'MyChatStreamCapacityHigh',
    'MyChatPayloadCleanupStalled',
    'MyChatTenantResourceHeadroomLow',
    'MyChatAdmissionReservationExpired',
    'MyChatBillingReconciliationStale',
    'MyChatBillingInvariantMismatch',
    'MyChatBillingReleaseBlocked',
  ]) {
    assert.match(alerts, new RegExp(`alert: ${alert}`))
  }
  for (const metric of [
    'mychat_authoritative_worker_fleet_ready',
    'mychat_authoritative_worker_queue_freshest_heartbeat_age_seconds',
    'mychat_authoritative_queue_oldest_age_seconds',
    'mychat_authoritative_jobs_terminal_window',
    'mychat_authoritative_slo_window_good',
    'mychat_authoritative_job_lease_expired',
    'mychat_authoritative_outbox_dead',
    'mychat_authoritative_lifecycle_active_streams',
    'mychat_authoritative_lifecycle_overdue_payloads',
    'mychat_authoritative_lifecycle_expired_admission_reservations',
    'mychat_authoritative_billing_snapshot_age_seconds',
    'mychat_authoritative_billing_mismatches_total',
  ]) {
    assert.match(alerts, new RegExp(metric))
  }
  assert.doesNotMatch(alerts, /user_id|principal_id|job_id|request_id|object_key/)
})

test('Grafana job control-plane dashboard is valid JSON with actionable queries', () => {
  const dashboard = JSON.parse(dashboardText) as {
    uid?: string
    refresh?: string
    panels?: Array<{ title?: string; targets?: Array<{ expr?: string }> }>
  }
  assert.equal(dashboard.uid, 'mychat-job-control-plane')
  assert.equal(dashboard.refresh, '15s')
  assert.ok((dashboard.panels?.length ?? 0) >= 10)
  const queries = dashboard.panels
    ?.flatMap(panel => panel.targets ?? [])
    .map(target => target.expr ?? '')
    .join('\n') ?? ''
  for (const metric of [
    'mychat_authoritative_worker_fleet_ready',
    'mychat_authoritative_worker_queue_freshest_heartbeat_age_seconds',
    'mychat_authoritative_queue_oldest_age_seconds',
    'mychat_authoritative_jobs_terminal_window',
    'mychat_authoritative_slo_window_good',
    'mychat_authoritative_job_lease_expired',
    'mychat_authoritative_outbox_dead',
    'mychat_authoritative_billing_release_ready',
    'mychat_authoritative_billing_mismatches_total',
    'mychat_authoritative_billing_release_blockers',
    'mychat_authoritative_billing_active_legacy_jobs',
    'mychat_authoritative_billing_snapshot_age_seconds',
  ]) {
    assert.match(queries, new RegExp(metric))
  }
})
