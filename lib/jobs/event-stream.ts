import type { SupabaseClient } from '@supabase/supabase-js'
import { isTerminalJobStatus, type JobStatus } from './contracts'
import { readOwnedJob, readOwnedJobEvents } from './read-model'

const POLL_INTERVAL_MS = 250
const HEARTBEAT_INTERVAL_MS = 10_000

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const abort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    signal.addEventListener('abort', abort, { once: true })
  })
}

function eventFrame(event: {
  seq: number
  kind: string
  schemaVersion: number
  jobId: string
  payload: object
  createdAt: string
}): string {
  return `id: ${event.seq}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`
}

export function createJobEventStream(input: {
  client: SupabaseClient
  principalId: string
  jobId: string
  fromSequence: number
  initialStatus: JobStatus
  requestSignal: AbortSignal
}): ReadableStream<Uint8Array> {
  const stop = new AbortController()
  const signal = AbortSignal.any([input.requestSignal, stop.signal])
  const encoder = new TextEncoder()
  let closed = false

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (value: string) => {
        if (!closed) controller.enqueue(encoder.encode(value))
      }
      let sequence = input.fromSequence
      let status = input.initialStatus
      let lastHeartbeat = Date.now()
      try {
        while (!signal.aborted) {
          const result = await readOwnedJobEvents(
            input.client,
            input.principalId,
            input.jobId,
            sequence,
          )
          if (!result.ok) {
            send(`event: stream.error\ndata: ${JSON.stringify({
              schemaVersion: 1,
              jobId: input.jobId,
              code: 'DEPENDENCY_UNAVAILABLE',
              retryable: true,
            })}\n\n`)
            break
          }
          for (const event of result.value) {
            sequence = event.seq
            send(eventFrame(event))
            const terminalStatus = event.kind === 'job.terminal' ? event.payload.status : null
            if (typeof terminalStatus === 'string' && isTerminalJobStatus(terminalStatus)) {
              status = terminalStatus
            }
          }
          if (isTerminalJobStatus(status) && result.value.length === 0) break
          if (result.value.length === 0) {
            const snapshot = await readOwnedJob(input.client, input.principalId, input.jobId)
            if (!snapshot.ok) break
            status = snapshot.value.status
          }
          if (Date.now() - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
            send(`: heartbeat ${sequence}\n\n`)
            lastHeartbeat = Date.now()
          }
          if (!isTerminalJobStatus(status)) await wait(POLL_INTERVAL_MS, signal)
        }
      } catch {
        // Disconnect and cancellation are normal; the client resumes by sequence.
      } finally {
        closed = true
        try { controller.close() } catch {}
      }
    },
    cancel(reason) {
      closed = true
      stop.abort(reason)
    },
  })
}
