import { NextRequest } from 'next/server'
import { resolveAuth } from '@/lib/api/guard'
import { listRunningForConversation } from '@/lib/generation/runtime'
import { loadLatestGenerationForConversation } from '@/lib/generation/persist'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(req: NextRequest) {
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
  const conversationId = req.nextUrl.searchParams.get('conversationId')
  if (!conversationId) return Response.json({ error: '缺少 conversationId' }, { status: 400 })
  if (!UUID.test(conversationId)) {
    return Response.json({ error: 'conversationId 无效' }, { status: 400 })
  }
  const live = listRunningForConversation(auth.userId, conversationId)
  const latestResult = await loadLatestGenerationForConversation(auth.userId, conversationId)
  if (latestResult.kind === 'unavailable') {
    return Response.json(
      { error: '生成任务协调服务暂时不可用，请稍后重试', recoverable: true },
      { status: 503, headers: { 'Retry-After': '2' } },
    )
  }
  const latest = latestResult.kind === 'found' ? latestResult.value : null
  const active = latest && (latest.status === 'queued' || latest.status === 'running')
    ? [latest]
    : []
  const missingDurableLocal = live.some(record => (
    record.durability === 'durable'
    && latest?.id !== record.id
  ))
  if (missingDurableLocal) {
    return Response.json(
      { error: '生成任务协调状态暂时不一致，请稍后重试', recoverable: true },
      { status: 503, headers: { 'Retry-After': '2' } },
    )
  }
  return Response.json({
    latest: latest ? {
      id: latest.id,
      conversationId: latest.conversation_id,
      assistantMessageId: latest.assistant_message_id,
      status: latest.status,
      content: latest.content ?? '',
      thinking: latest.thinking ?? '',
      media: latest.media ?? [],
      sequence: latest.sequence ?? 0,
      error: latest.error,
      source: 'db',
    } : null,
    generations: [
      ...active.map(row => ({
          id: row.id,
          conversationId: row.conversation_id,
          assistantMessageId: row.assistant_message_id,
          status: row.status,
          content: row.content ?? '',
          thinking: row.thinking ?? '',
          media: row.media ?? [],
          sequence: row.sequence ?? 0,
          source: 'db',
        })),
      ...live
        .filter(r => r.durability === 'ephemeral' && !active.some(row => row.id === r.id))
        .map(r => ({
          id: r.id,
          conversationId: r.conversationId,
          assistantMessageId: r.assistantMessageId,
          status: r.status,
          content: r.content,
          thinking: r.thinking,
          media: r.media,
          sequence: r.sequence,
          source: 'memory',
        })),
    ],
  })
}
