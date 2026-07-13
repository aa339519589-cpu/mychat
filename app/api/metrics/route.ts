import { timingSafeEqual } from 'node:crypto'
import { exportJobMetrics } from '@/lib/observability/job-metrics'
import {
  exportAuthoritativeJobMetrics,
  readAuthoritativeJobMetrics,
} from '@/lib/observability/authoritative-job-metrics'

function authorized(request: Request): boolean {
  const expected = process.env.METRICS_BEARER_TOKEN?.trim()
  const header = request.headers.get('authorization') ?? ''
  const received = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!expected || !received) return false
  const left = Buffer.from(expected)
  const right = Buffer.from(received)
  return left.length === right.length && timingSafeEqual(left, right)
}

export async function GET(request: Request): Promise<Response> {
  if (!authorized(request)) return new Response(null, { status: 404 })
  try {
    const authoritative = await readAuthoritativeJobMetrics()
    return new Response(
      `${exportAuthoritativeJobMetrics(authoritative)}${exportJobMetrics()}`,
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
