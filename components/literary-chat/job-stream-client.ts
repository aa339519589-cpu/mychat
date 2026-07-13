import { isRecord } from '@/lib/unknown-value'
import { parseSseEvent, splitSseEvents } from './stream-events'

export type AcceptedJob = {
  jobId: string
  streamUrl: string
  status: string
}

export type JobStreamEnvelope = {
  jobId: string
  seq: number
  kind: string
  payload: Record<string, unknown>
}

function responseError(value: unknown, status: number): string {
  if (!isRecord(value)) return `请求失败（${status}）`
  if (typeof value.error === 'string') return value.error
  if (isRecord(value.error) && typeof value.error.message === 'string') return value.error.message
  return `请求失败（${status}）`
}

export async function enqueueJob(
  path: string,
  body: unknown,
  signal: AbortSignal,
): Promise<AcceptedJob> {
  const response = await fetch(path, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload: unknown = await response.json().catch(() => null)
  if (!response.ok) throw new Error(responseError(payload, response.status))
  if (!isRecord(payload) || typeof payload.jobId !== 'string'
    || typeof payload.streamUrl !== 'string' || typeof payload.status !== 'string') {
    throw new Error('作业入队响应无效')
  }
  return { jobId: payload.jobId, streamUrl: payload.streamUrl, status: payload.status }
}

function abortableWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const timer = setTimeout(resolve, milliseconds)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason)
    }, { once: true })
  })
}

function streamUrl(path: string, sequence: number): string {
  const url = new URL(path, window.location.origin)
  url.searchParams.set('from_seq', String(sequence))
  return `${url.pathname}${url.search}`
}

/** Durable SSE client: reconnects from the last database sequence, never from
 * a process-local cursor. Duplicate delivery is ignored and gaps are rejected. */
export async function* streamJobEvents(
  accepted: AcceptedJob,
  signal: AbortSignal,
  deadlineMs = 20 * 60_000,
): AsyncGenerator<JobStreamEnvelope> {
  let sequence = 0
  let retryMs = 250
  const deadline = Date.now() + deadlineMs
  while (!signal.aborted && Date.now() < deadline) {
    try {
      const response = await fetch(streamUrl(accepted.streamUrl, sequence), {
        signal,
        headers: sequence > 0 ? { 'Last-Event-ID': String(sequence) } : undefined,
      })
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null)
        throw new Error(responseError(payload, response.status))
      }
      if (!response.body) throw new Error('作业事件流无响应体')
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let terminal = false
      while (!signal.aborted) {
        const chunk = await reader.read()
        if (chunk.done) break
        const split = splitSseEvents(buffer + decoder.decode(chunk.value, { stream: true }))
        buffer = split.rest
        for (const text of split.events) {
          const event = parseSseEvent(text)
          if (!event || event.kind === 'done' || !isRecord(event.data)) continue
          const data = event.data
          if (typeof data.code === 'string' && data.retryable === true) {
            throw new Error(data.code)
          }
          if (typeof data.jobId !== 'string' || !Number.isSafeInteger(data.seq)
            || typeof data.kind !== 'string' || !isRecord(data.payload)) continue
          const next = Number(data.seq)
          if (next <= sequence) continue
          if (next !== sequence + 1) throw new Error('作业事件序列出现缺口')
          sequence = next
          const envelope = { jobId: data.jobId, seq: next, kind: data.kind, payload: data.payload }
          yield envelope
          if (data.kind === 'job.terminal') {
            terminal = true
            break
          }
        }
        if (terminal) break
      }
      try { await reader.cancel() } catch {}
      if (terminal) return
      retryMs = 250
    } catch (error) {
      if (signal.aborted) throw signal.reason
      if (Date.now() >= deadline) throw error
    }
    await abortableWait(retryMs, signal)
    retryMs = Math.min(5_000, retryMs * 2)
  }
  if (!signal.aborted) throw new Error('作业事件订阅超时')
}
