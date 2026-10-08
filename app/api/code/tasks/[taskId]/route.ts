import { NextRequest } from 'next/server'
import { resolveAuth } from '@/lib/api/guard'
import { readCodeRecovery } from '@/lib/code-agent/recovery'
import { isUuid } from '@/lib/validation'

export async function GET(request: NextRequest, context: { params: Promise<{ taskId: string }> }) {
  const auth = await resolveAuth(request)
  if (auth.authUnavailable) return Response.json({ error: '认证服务暂时不可用' }, { status: 503 })
  if (!auth.userId || !auth.supabase) return Response.json({ error: '请先登录' }, { status: 401 })
  const { taskId } = await context.params
  if (!isUuid(taskId)) return Response.json({ error: 'taskId 无效' }, { status: 400 })
  try {
    const result = await readCodeRecovery(auth.supabase, auth.userId, { taskId }, request.signal)
    return Response.json(result, { status: result.task ? 200 : 404, headers: { 'Cache-Control': 'no-store' } })
  } catch { return Response.json({ error: '任务恢复服务暂时不可用' }, { status: 503 }) }
}
