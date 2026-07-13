import { getRuntimeHealth } from '@/lib/supabase/health'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** Strict deployment readiness endpoint used by the Render health check. */
export async function GET() {
  const health = await getRuntimeHealth()
  return Response.json({
    status: health.ready ? 'ok' : 'degraded',
    ...health,
  }, {
    status: health.ready ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  })
}
