import { resolveAuth } from '@/lib/api/guard'
import { deleteAllConversationsWithGeneratedMedia } from '@/lib/chat/history-deletion'

export async function DELETE() {
  const auth = await resolveAuth()
  if (auth.authUnavailable) return Response.json({ error: '认证服务暂时不可用，请稍后再试' }, { status: 503 })
  if (!auth.userId) return Response.json({ error: '请先登录' }, { status: 401 })
  const result = await deleteAllConversationsWithGeneratedMedia(auth.userId)
  if (result.kind === 'deleted') return Response.json({ ok: true, count: result.count })
  if (result.kind === 'active_generation') {
    return Response.json({ error: '存在正在生成的对话，请先停止生成后再试' }, { status: 409 })
  }
  return Response.json({ error: '删除服务暂时不可用，请稍后再试' }, { status: 503 })
}
