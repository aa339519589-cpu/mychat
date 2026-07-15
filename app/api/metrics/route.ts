import {
  exportAuthoritativeJobMetrics,
  readAuthoritativeJobMetrics,
} from '@/lib/observability/authoritative-job-metrics'
import {
  exportWorkerFleetMetrics,
  readWorkerFleetMetrics,
} from '@/lib/observability/worker-fleet-metrics'
import {
  exportStreamLifecycleMetrics,
  readStreamLifecycleMetrics,
} from '@/lib/observability/stream-lifecycle-metrics'
import {
  exportBillingReconciliationMetrics,
  readBillingReconciliationMetrics,
} from '@/lib/observability/billing-reconciliation-metrics'
import { metricsRequestAuthorized } from '@/lib/observability/metrics-auth'

export async function GET(request: Request): Promise<Response> {
  if (!metricsRequestAuthorized(request.headers.get('authorization'))) {
    return new Response(null, { status: 404 })
  }
  try {
    const [authoritative, workerFleet, lifecycle, billing] = await Promise.all([
      readAuthoritativeJobMetrics(),
      readWorkerFleetMetrics(),
      readStreamLifecycleMetrics(),
      readBillingReconciliationMetrics(),
    ])
    return new Response(
      `${exportAuthoritativeJobMetrics(authoritative)}${exportWorkerFleetMetrics(workerFleet)}${exportStreamLifecycleMetrics(lifecycle)}${exportBillingReconciliationMetrics(billing)}`,
      {
        headers: {
          'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      },
    )
  } catch {
    // A local-only scrape could look healthy while every worker is disconnected
    // from the system of record, so an authoritative read failure fails closed.
    return new Response(null, {
      status: 503,
      headers: { 'Cache-Control': 'no-store', 'Retry-After': '5' },
    })
  }
}
