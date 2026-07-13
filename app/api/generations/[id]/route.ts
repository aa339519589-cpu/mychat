import { NextRequest } from 'next/server'
import { resolveAuth } from '@/lib/api/guard'
import { getGenerationForUser } from '@/lib/generation/runtime'
import { loadGenerationFromDb } from '@/lib/generation/persist'
import { selectGenerationStreamSource } from '@/lib/generation/stream-source'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
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
  if (!UUID.test(id)) return Response.json({ error: 'generationId 无效' }, { status: 400 })

  const live = getGenerationForUser(id, auth.userId)
  const database = await loadGenerationFromDb(id, auth.userId)
  const source = selectGenerationStreamSource(database, live)
  if (source.kind === 'database') {
    const row = source.row
    return Response.json({
      id: row.id,
      conversationId: row.conversation_id,
      assistantMessageId: row.assistant_message_id,
      status: row.status,
      content: row.content ?? '',
      thinking: row.thinking ?? '',
      media: row.media ?? [],
      sequence: row.sequence ?? 0,
      error: row.error,
      source: 'db',
    })
  }

  if (source.kind === 'coordination_unavailable') {
    return Response.json(
      { error: '生成任务协调服务暂时不可用，请稍后重试', recoverable: true },
      { status: 503, headers: { 'Retry-After': '2' } },
    )
  }
  if (source.kind === 'missing' || !live) {
    return Response.json({ error: '生成任务不存在' }, { status: 404 })
  }
  const r = live.record
  return Response.json({
    id: r.id,
    conversationId: r.conversationId,
    assistantMessageId: r.assistantMessageId,
    status: r.status,
    content: r.content,
    thinking: r.thinking,
    media: r.media,
    sequence: r.sequence,
    error: r.error,
    source: 'memory',
  })
}
