import { NextRequest } from 'next/server'
import { resolveAuth } from '@/lib/api/guard'
import { readCodeRecovery } from '@/lib/code-agent/recovery'
import { isUuid } from '@/lib/validation'

export async function GET(request: NextRequest) {
  const auth = await resolveAuth(request)
  if (auth.authUnavailable) return Response.json({ error: '认证服务暂时不可用' }, { status: 503 })
  if (!auth.userId || !auth.supabase) return Response.json({ error: '请先登录' }, { status: 401 })
  const sessionId = request.nextUrl.searchParams.get('sessionId')
  if (!isUuid(sessionId)) return Response.json({ error: 'sessionId 无效' }, { status: 400 })
  try {
    return Response.json(await readCodeRecovery(auth.supabase, auth.userId, { sessionId }, request.signal),
      { headers: { 'Cache-Control': 'no-store' } })
  } catch { return Response.json({ error: '任务恢复服务暂时不可用' }, { status: 503 }) }
}
