import { getRuntimeHealth } from '@/lib/supabase/health'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** Strict dependency readiness used by release and activation gates. */
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
