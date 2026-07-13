import { NextRequest } from 'next/server'
import { resolveAuth } from '@/lib/api/guard'
import { coordinateGenerationCancellation } from '@/lib/generation/cancel-service'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  if (!UUID.test(id)) return Response.json({ error: '生成任务不存在' }, { status: 404 })

  const auth = await resolveAuth()
  if (auth.authUnavailable) {
    return Response.json(
      { error: '认证服务暂时不可用，请稍后再试' },
      { status: 503, headers: { 'Retry-After': '5' } },
    )
  }
  if (!auth.userId || !auth.supabase) {
    return Response.json({ error: '请先登录' }, { status: 401 })
  }

  const result = await coordinateGenerationCancellation({
    userId: auth.userId,
    generationId: id,
  })
  if (result.kind === 'unavailable') {
    return Response.json(
      { error: '取消服务暂时不可用，请稍后再试' },
      { status: 503, headers: { 'Retry-After': '1' } },
    )
  }
  if (result.kind === 'not_found') {
    return Response.json({ error: '生成任务不存在' }, { status: 404 })
  }
  if (result.kind === 'transitioning') {
    return Response.json(
      { error: '任务状态正在变化，请重试取消' },
      { status: 409, headers: { 'Retry-After': '1' } },
    )
  }

  return Response.json({
    ok: true,
    status: result.terminal.status,
    terminal: result.terminal,
    ...(result.accepted ? {} : { note: 'already_terminal' }),
  })
}
