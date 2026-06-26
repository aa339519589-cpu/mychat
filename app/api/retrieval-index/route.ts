import { NextRequest } from 'next/server'
import { resolveAuth } from '@/lib/api/guard'
import { backfillUserConversationIndex, ensureConversationIndexed } from '@/lib/llm/active-retrieval'

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } })
}

export async function POST(req: NextRequest) {
  const { supabase, userId } = await resolveAuth()
  if (!supabase || !userId) return json({ error: '未登录' }, 401)

  let body: any = {}
  try { body = await req.json() } catch {}

  const conversationId = typeof body.conversationId === 'string' ? body.conversationId : null
  const limit = Number.isFinite(Number(body.limit)) ? Math.max(1, Math.min(200, Number(body.limit))) : 40

  if (conversationId) {
    await ensureConversationIndexed(supabase, userId, conversationId)
    return json({ ok: true, mode: 'conversation', conversationId })
  }

  const result = await backfillUserConversationIndex(supabase, userId, limit)
  return json({ ok: true, mode: 'user_backfill', ...result })
}
