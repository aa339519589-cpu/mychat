import { NextRequest } from 'next/server'
import { resolveAuth } from '@/lib/api/guard'
import { getGenerationForUser, subscribe, maybeGc } from '@/lib/generation/runtime'
import { loadGenerationFromDb } from '@/lib/generation/persist'
import { log } from '@/lib/logger'

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const auth = await resolveAuth()
  if (!auth.userId) return Response.json({ error: '请先登录' }, { status: 401 })

  const after = Number(req.nextUrl.searchParams.get('afterSequence') || '0') || 0
  let entry = getGenerationForUser(id, auth.userId)

  // If not in memory but completed in DB, return a one-shot snapshot stream
  if (!entry && auth.supabase) {
    const row = await loadGenerationFromDb(auth.supabase as any, id, auth.userId)
    if (!row) return Response.json({ error: '生成任务不存在' }, { status: 404 })
    const snapshot = {
      generationId: row.id,
      conversationId: row.conversation_id,
      assistantMessageId: row.assistant_message_id,
      sequence: row.sequence ?? 0,
      type: 'done',
      status: row.status,
      content: row.content ?? '',
      thinking: row.thinking ?? '',
      error: row.error,
    }
    const body = `data: ${JSON.stringify(snapshot)}\n\ndata: ${JSON.stringify({ ...snapshot, type: 'done' })}\n\n`
    return new Response(body, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
    })
  }

  if (!entry) return Response.json({ error: '生成任务不存在' }, { status: 404 })

  log.info('generation', 'task resumed', {
    generationId: id,
    conversationId: entry.record.conversationId,
    afterSequence: after,
    status: entry.record.status,
    sequence: entry.record.sequence,
  })

  let unsubscribe: (() => void) | null = null
  let closed = false
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      const send = (data: unknown) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
        } catch {
          closed = true
        }
      }
      unsubscribe = subscribe(id, (event) => {
        send(event)
        if (event.type === 'done' || event.status === 'completed' || event.status === 'failed' || event.status === 'cancelled') {
          closed = true
          try { controller.close() } catch { /* ignore */ }
          maybeGc(id)
        }
      }, after)
      // If already finished, close soon
      const st = entry!.record.status
      if (st === 'completed' || st === 'failed' || st === 'cancelled') {
        setTimeout(() => {
          if (!closed) {
            closed = true
            try { controller.close() } catch { /* ignore */ }
          }
        }, 50)
      }
    },
    cancel() {
      closed = true
      unsubscribe?.()
      maybeGc(id)
    },
  })

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
  })
}
