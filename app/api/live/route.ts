import { getRuntimeLiveness } from '@/lib/supabase/health'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** Dependency-free process liveness. Readiness belongs at /api/ready. */
export function GET() {
  return Response.json({
    status: 'ok',
    ...getRuntimeLiveness(),
  }, {
    status: 200,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
