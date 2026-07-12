import { NextRequest } from 'next/server'
import { resolveAuth } from '@/lib/api/guard'
import { listRunningForConversation } from '@/lib/generation/runtime'
import { loadRunningGenerations } from '@/lib/generation/persist'

export async function GET(req: NextRequest) {
  const auth = await resolveAuth()
  if (!auth.userId || !auth.supabase) {
    return Response.json({ error: '请先登录' }, { status: 401 })
  }
  const conversationId = req.nextUrl.searchParams.get('conversationId')
  if (!conversationId) return Response.json({ error: '缺少 conversationId' }, { status: 400 })
  const live = listRunningForConversation(auth.userId, conversationId)
  const db = await loadRunningGenerations(auth.supabase as any, auth.userId, conversationId)
  return Response.json({
    generations: [
      ...live.map(r => ({
        id: r.id,
        conversationId: r.conversationId,
        assistantMessageId: r.assistantMessageId,
        status: r.status,
        content: r.content,
        thinking: r.thinking,
        sequence: r.sequence,
        source: 'memory',
      })),
      ...db
        .filter((row: any) => !live.some(l => l.id === row.id))
        .map((row: any) => ({
          id: row.id,
          conversationId: row.conversation_id,
          assistantMessageId: row.assistant_message_id,
          status: row.status,
          content: row.content ?? '',
          thinking: row.thinking ?? '',
          sequence: row.sequence ?? 0,
          source: 'db',
        })),
    ],
  })
}
