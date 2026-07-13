import { NextRequest } from 'next/server'
import { getRuntimeHealth } from '@/lib/supabase/health'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  const health = await getRuntimeHealth()
  const readinessProbe = request.nextUrl.searchParams.get('ready') === '1'
    || request.nextUrl.searchParams.get('mode') === 'ready'
  return Response.json({
    status: health.ready ? 'ok' : 'degraded',
    ...health,
  }, {
    // The default URL is a liveness endpoint. Readiness mode is strict and can be
    // used by the deployment platform to stop routing traffic to an unready release.
    status: readinessProbe && !health.ready ? 503 : 200,
    headers: { 'Cache-Control': 'no-store' },
  })
}
