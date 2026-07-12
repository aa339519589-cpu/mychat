import { NextRequest } from 'next/server'
import { resolveAuth } from '@/lib/api/guard'
import { getGenerationForUser } from '@/lib/generation/runtime'
import { loadGenerationFromDb } from '@/lib/generation/persist'

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const auth = await resolveAuth()
  if (!auth.userId || !auth.supabase) {
    return Response.json({ error: '请先登录' }, { status: 401 })
  }

  const live = getGenerationForUser(id, auth.userId)
  if (live) {
    const r = live.record
    return Response.json({
      id: r.id,
      conversationId: r.conversationId,
      assistantMessageId: r.assistantMessageId,
      status: r.status,
      content: r.content,
      thinking: r.thinking,
      sequence: r.sequence,
      error: r.error,
      source: 'memory',
    })
  }

  const row = await loadGenerationFromDb(auth.supabase as any, id, auth.userId)
  if (!row) return Response.json({ error: '生成任务不存在' }, { status: 404 })
  return Response.json({
    id: row.id,
    conversationId: row.conversation_id,
    assistantMessageId: row.assistant_message_id,
    status: row.status,
    content: row.content ?? '',
    thinking: row.thinking ?? '',
    sequence: row.sequence ?? 0,
    error: row.error,
    source: 'db',
  })
}
