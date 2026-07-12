import { NextRequest } from 'next/server'
import { resolveAuth } from '@/lib/api/guard'
import { cancelGeneration, getGenerationForUser } from '@/lib/generation/runtime'
import { persistAssistantMessage, persistGenerationRow } from '@/lib/generation/persist'
import { log } from '@/lib/logger'

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const auth = await resolveAuth()
  if (!auth.userId || !auth.supabase) {
    return Response.json({ error: '请先登录' }, { status: 401 })
  }
  const entry = getGenerationForUser(id, auth.userId)
  const ok = cancelGeneration(id, auth.userId)
  if (!ok && !entry) {
    // Best-effort mark DB cancelled even if not in memory
    try {
      await (auth.supabase as any).from('chat_generations')
        .update({ status: 'cancelled', updated_at: new Date().toISOString() })
        .eq('id', id)
        .eq('user_id', auth.userId)
    } catch { /* ignore */ }
    return Response.json({ ok: true, note: 'not_in_memory' })
  }
  if (entry) {
    await persistGenerationRow(auth.supabase as any, {
      id: entry.record.id,
      userId: entry.record.userId,
      conversationId: entry.record.conversationId,
      assistantMessageId: entry.record.assistantMessageId,
      status: 'cancelled',
      content: entry.record.content,
      thinking: entry.record.thinking,
      sequence: entry.record.sequence,
    })
    await persistAssistantMessage(auth.supabase as any, entry.record.assistantMessageId, {
      content: entry.record.content,
      thinking: entry.record.thinking || null,
    })
  }
  log.info('generation', 'cancel api', { generationId: id, userId: auth.userId })
  return Response.json({ ok: true })
}
