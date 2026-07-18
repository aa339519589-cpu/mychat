import { NextRequest } from 'next/server'
import { resolveAuth } from '@/lib/api/guard'
import { deleteConversationWithGeneratedMedia } from '@/lib/chat/history-deletion'

export async function DELETE(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await resolveAuth()
  if (auth.authUnavailable) {
    return Response.json({ error: '认证服务暂时不可用，请稍后再试' }, { status: 503, headers: { 'Retry-After': '5' } })
  }
  if (!auth.userId) return Response.json({ error: '请先登录' }, { status: 401 })
  const { id } = await ctx.params
  const result = await deleteConversationWithGeneratedMedia(auth.userId, id)
  if (result.kind === 'deleted') {
    return Response.json({ ok: true, cleanupPending: result.cleanupPending })
  }
  if (result.kind === 'active_generation') {
    return Response.json({ error: '会话仍在生成，请先停止并等待终态确认' }, { status: 409, headers: { 'Retry-After': '1' } })
  }
  // DELETE is idempotent: a retry after a lost response must still succeed.
  if (result.kind === 'not_found') return Response.json({ ok: true, alreadyDeleted: true })
  return Response.json({ error: '删除服务暂时不可用，请稍后再试' }, { status: 503, headers: { 'Retry-After': '2' } })
}
