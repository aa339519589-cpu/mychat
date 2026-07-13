import { NextRequest } from 'next/server'
import { resolveAuth } from '@/lib/api/guard'
import { checkRateLimit } from '@/lib/rate-limit'
import { getGenerationForUser, subscribe, maybeGc } from '@/lib/generation/runtime'
import { loadGenerationFromDb } from '@/lib/generation/persist'
import {
  createDatabaseGenerationStream,
  GENERATION_STREAM_HEADERS,
} from '@/lib/generation/db-stream'
import {
  acquireGenerationStreamPermit,
  GENERATION_STREAM_CONNECTIONS_PER_MINUTE,
} from '@/lib/generation/stream-limits'
import { selectGenerationStreamSource } from '@/lib/generation/stream-source'
import { isTerminalGenerationStatus } from '@/lib/generation/types'
import { log } from '@/lib/logger'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
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

  const rate = await checkRateLimit(`generation-stream:${auth.userId}`, {
    max: GENERATION_STREAM_CONNECTIONS_PER_MINUTE,
    windowMs: 60_000,
  })
  if (rate.unavailable) {
    return Response.json(
      { error: '生成任务协调服务暂时不可用，请稍后重试' },
      { status: 503, headers: { 'Retry-After': String(rate.retryAfterSeconds) } },
    )
  }
  if (!rate.allowed) {
    return Response.json(
      { error: '生成流连接过于频繁，请稍后重试' },
      { status: 429, headers: { 'Retry-After': String(rate.retryAfterSeconds) } },
    )
  }

  const permit = acquireGenerationStreamPermit(auth.userId)
  if (!permit.acquired) {
    return Response.json(
      { error: '当前生成流连接过多，请关闭其他连接后重试' },
      { status: 429, headers: { 'Retry-After': '2' } },
    )
  }

  let permitTransferredToStream = false
  try {
    const requestedAfter = Number(req.nextUrl.searchParams.get('afterSequence') || '0')
    const after = Number.isSafeInteger(requestedAfter) && requestedAfter > 0 ? requestedAfter : 0
    const entry = getGenerationForUser(id, auth.userId)
    const database = await loadGenerationFromDb(id, auth.userId)
    const source = selectGenerationStreamSource(database, entry)

    // Database state is authoritative even when this instance owns the runner.
    // A failed database read is never treated as a missing row, and durable
    // local entries therefore cannot bypass fencing during a partition.
    if (source.kind === 'database') {
      const row = source.row
      log.info('generation', 'task resumed from database', {
        generationId: id,
        conversationId: row.conversation_id,
        afterSequence: after,
        status: row.status,
        sequence: row.sequence ?? 0,
      })
      const stream = createDatabaseGenerationStream(
        row,
        () => loadGenerationFromDb(id, auth.userId!),
        after,
        { signal: req.signal, onClose: permit.release },
      )
      permitTransferredToStream = true
      return new Response(stream, { headers: GENERATION_STREAM_HEADERS })
    }

    if (source.kind === 'coordination_unavailable') {
      log.warn('generation', 'resume failed closed because database authority is unavailable', {
        generationId: id,
        reason: source.reason,
        hasLocalEntry: Boolean(entry),
      })
      return Response.json(
        { error: '生成任务协调服务暂时不可用，请稍后重新连接', recoverable: true },
        { status: 503, headers: { 'Retry-After': '2' } },
      )
    }
    if (source.kind === 'missing' || !entry) {
      return Response.json({ error: '生成任务不存在' }, { status: 404 })
    }

    log.info('generation', 'ephemeral task resumed from local runner', {
      generationId: id,
      conversationId: entry.record.conversationId,
      afterSequence: after,
      status: entry.record.status,
      sequence: entry.record.sequence,
    })

    let unsubscribe: (() => void) | null = null
    let heartbeat: ReturnType<typeof setInterval> | null = null
    let closeStream: ((closeController?: boolean) => void) | null = null
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        let closed = false
        const cleanup = () => {
          unsubscribe?.()
          unsubscribe = null
          if (heartbeat) clearInterval(heartbeat)
          heartbeat = null
          req.signal.removeEventListener('abort', close)
          permit.release()
        }
        const finish = (closeController = true) => {
          if (closed) return
          closed = true
          cleanup()
          if (closeController) {
            try { controller.close() } catch { /* stream already closed */ }
          }
          maybeGc(id)
        }
        const close = () => finish(true)
        const send = (data: unknown) => {
          if (closed) return
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
          } catch {
            finish(false)
          }
        }
        closeStream = finish
        req.signal.addEventListener('abort', close, { once: true })
        if (req.signal.aborted) {
          close()
          return
        }

        const subscription = subscribe(id, (event) => {
          send(event)
          if (event.type === 'done' || isTerminalGenerationStatus(event.status)) close()
        }, after)
        unsubscribe = subscription
        if (closed) {
          unsubscribe?.()
          unsubscribe = null
          return
        }
        if (!subscription) {
          close()
          return
        }
        heartbeat = setInterval(() => send({ heartbeat: true }), 8_000)
        send({ heartbeat: true })
      },
      cancel() {
        closeStream?.(false)
      },
    })

    permitTransferredToStream = true
    return new Response(stream, { headers: GENERATION_STREAM_HEADERS })
  } finally {
    if (!permitTransferredToStream) permit.release()
  }
}
