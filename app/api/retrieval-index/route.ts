import { NextRequest } from 'next/server'
import { resolveAuth } from '@/lib/api/guard'
import { backfillUserConversationIndex, ensureConversationIndexed } from '@/lib/llm/active-retrieval'

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } })
}

async function runIndex(req: NextRequest, body: any = {}) {
  const { supabase, userId } = await resolveAuth()
  if (!supabase || !userId) return json({ error: '未登录' }, 401)

  const url = new URL(req.url)
  const conversationId = typeof body.conversationId === 'string'
    ? body.conversationId
    : url.searchParams.get('conversationId')
  const rawLimit = body.limit ?? url.searchParams.get('limit') ?? 40
  const limit = Number.isFinite(Number(rawLimit)) ? Math.max(1, Math.min(200, Number(rawLimit))) : 40

  if (conversationId) {
    await ensureConversationIndexed(supabase, userId, conversationId)
    return json({ ok: true, mode: 'conversation', conversationId })
  }

  const result = await backfillUserConversationIndex(supabase, userId, limit)
  return json({ ok: true, mode: 'user_backfill', ...result })
}

export async function GET(req: NextRequest) {
  return runIndex(req)
}

export async function POST(req: NextRequest) {
  let body: any = {}
  try { body = await req.json() } catch {}
  return runIndex(req, body)
}
