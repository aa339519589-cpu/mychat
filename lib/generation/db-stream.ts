import { log } from '@/lib/logger'
import type { GenerationReadResult } from './persist'
import {
  isTerminalGenerationStatus,
  type GenerationDatabaseRow,
  type GenerationEvent,
  type GenerationStatus,
} from './types'

const DEFAULT_POLL_INTERVAL_MS = 1_000
const DEFAULT_HEARTBEAT_INTERVAL_MS = 8_000
const DEFAULT_MAX_CONSECUTIVE_READ_FAILURES = 3
const COORDINATION_ERROR = '生成任务协调服务暂时不可用，请稍后重新连接'

type DatabaseGenerationStreamOptions = {
  pollIntervalMs?: number
  heartbeatIntervalMs?: number
  maxConsecutiveReadFailures?: number
  signal?: AbortSignal
  onClose?: () => void
}

function snapshotEvent(row: GenerationDatabaseRow): GenerationEvent {
  const terminal = isTerminalGenerationStatus(row.status)
  return {
    generationId: row.id,
    conversationId: row.conversation_id,
    assistantMessageId: row.assistant_message_id,
    sequence: row.sequence ?? 0,
    type: terminal ? 'done' : 'status',
    status: row.status,
    content: row.content ?? '',
    thinking: row.thinking ?? '',
    media: row.media ?? [],
    ...(row.error ? { error: row.error } : {}),
  }
}

/**
 * Polls a durable generation row until it reaches a terminal state.
 * This is used when the HTTP request lands on a different instance from the runner.
 */
export function createDatabaseGenerationStream(
  initialRow: GenerationDatabaseRow,
  loadLatest: () => Promise<GenerationReadResult<GenerationDatabaseRow>>,
  afterSequence = 0,
  options: DatabaseGenerationStreamOptions = {},
): ReadableStream<Uint8Array> {
  const pollIntervalMs = Math.max(10, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)
  const heartbeatIntervalMs = Math.max(100, options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS)
  const maxConsecutiveReadFailures = Math.min(
    20,
    Math.max(1, Math.floor(
      options.maxConsecutiveReadFailures ?? DEFAULT_MAX_CONSECUTIVE_READ_FAILURES,
    )),
  )

  let dispose: (() => void) | null = null
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      let closed = false
      let polling = false
      let lastSequence = Math.max(0, afterSequence)
      let lastStatus: GenerationStatus | null = null
      let consecutiveReadFailures = 0
      let pollTimer: ReturnType<typeof setInterval> | null = null
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null

      const cleanup = () => {
        if (pollTimer) clearInterval(pollTimer)
        if (heartbeatTimer) clearInterval(heartbeatTimer)
        pollTimer = null
        heartbeatTimer = null
        options.signal?.removeEventListener('abort', close)
      }
      const finish = (closeController: boolean) => {
        if (closed) return
        closed = true
        cleanup()
        try { options.onClose?.() } catch { /* release callbacks must not break cleanup */ }
        if (closeController) {
          try { controller.close() } catch { /* stream already closed */ }
        }
      }
      const close = () => finish(true)
      const send = (event: unknown) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        } catch {
          finish(false)
        }
      }
      dispose = () => finish(false)
      const publish = (row: GenerationDatabaseRow) => {
        if (closed) return
        const sequence = row.sequence ?? 0
        if (lastStatus !== row.status || sequence > lastSequence) {
          send(snapshotEvent(row))
          lastStatus = row.status
          lastSequence = Math.max(lastSequence, sequence)
        }
        if (isTerminalGenerationStatus(row.status)) close()
      }
      const recordReadFailure = (readKind: 'not_found' | 'unavailable' | 'exception', detail?: string) => {
        consecutiveReadFailures += 1
        log.warn('generation', 'database stream read unavailable', {
          generationId: initialRow.id,
          readKind,
          detail,
          consecutiveReadFailures,
        })
        if (consecutiveReadFailures < maxConsecutiveReadFailures) return
        send({
          generationId: initialRow.id,
          conversationId: initialRow.conversation_id,
          assistantMessageId: initialRow.assistant_message_id,
          sequence: lastSequence,
          type: 'error',
          status: lastStatus ?? initialRow.status,
          error: COORDINATION_ERROR,
          code: 'generation_coordination_unavailable',
          recoverable: true,
        })
        close()
      }
      const poll = async () => {
        if (closed || polling) return
        polling = true
        try {
          const result = await loadLatest()
          if (result.kind === 'found') {
            consecutiveReadFailures = 0
            publish(result.value)
          } else if (result.kind === 'not_found') {
            recordReadFailure('not_found')
          } else {
            recordReadFailure('unavailable', result.reason)
          }
        } catch (error) {
          recordReadFailure('exception', error instanceof Error ? error.name : 'unknown')
        } finally {
          polling = false
        }
      }

      options.signal?.addEventListener('abort', close, { once: true })
      if (options.signal?.aborted) {
        close()
        return
      }
      publish(initialRow)
      if (closed) return

      pollTimer = setInterval(() => { void poll() }, pollIntervalMs)
      heartbeatTimer = setInterval(() => send({ heartbeat: true }), heartbeatIntervalMs)
    },
    cancel() {
      dispose?.()
    },
  })
}

export const GENERATION_STREAM_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  'X-Accel-Buffering': 'no',
}
