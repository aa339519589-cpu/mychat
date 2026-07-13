import { NextRequest } from 'next/server'
import { resolveAuth } from '@/lib/api/guard'
import { deleteMessagesWithGeneratedMedia } from '@/lib/chat/history-deletion'

export async function POST(request: NextRequest) {
  const auth = await resolveAuth()
  if (auth.authUnavailable) {
    return Response.json({ error: '认证服务暂时不可用，请稍后再试' }, { status: 503, headers: { 'Retry-After': '5' } })
  }
  if (!auth.userId) return Response.json({ error: '请先登录' }, { status: 401 })
  let ids: unknown
  try { ids = (await request.json() as { ids?: unknown }).ids } catch {
    return Response.json({ error: '删除请求无效' }, { status: 400 })
  }
  const result = await deleteMessagesWithGeneratedMedia(auth.userId, ids)
  if (result.kind === 'deleted') {
    return Response.json({
      ok: true,
      deleted: result.messageIds.length,
      cleanupPending: result.cleanupPending,
    })
  }
  if (result.kind === 'active_generation') {
    return Response.json({ error: '会话仍在生成，请先停止并等待终态确认' }, { status: 409, headers: { 'Retry-After': '1' } })
  }
  if (result.kind === 'not_found') return Response.json({ error: '消息不存在' }, { status: 404 })
  return Response.json({ error: '删除服务暂时不可用，请稍后再试' }, { status: 503, headers: { 'Retry-After': '2' } })
}
