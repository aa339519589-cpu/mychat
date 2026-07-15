import type { SupabaseClient } from '@supabase/supabase-js'
import { isTerminalJobStatus, type JobStatus } from './contracts'
import { readOwnedJob, readOwnedJobEvents } from './read-model'

const INITIAL_POLL_INTERVAL_MS = 250
const MAX_POLL_INTERVAL_MS = 2_000
const HEARTBEAT_INTERVAL_MS = 10_000
const STATUS_REFRESH_INTERVAL_MS = 5_000
const ADMISSION_RENEW_INTERVAL_MS = 15_000
const BACKPRESSURE_TIMEOUT_MS = 5_000
const BACKPRESSURE_POLL_MS = 50

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

type JobEventStreamDependencies = {
  readEvents: typeof readOwnedJobEvents
  readJob: typeof readOwnedJob
  wait: typeof wait
  now: () => number
  initialPollIntervalMs: number
  maxPollIntervalMs: number
  statusRefreshIntervalMs: number
  heartbeatIntervalMs: number
  admissionRenewIntervalMs: number
  backpressureTimeoutMs: number
  backpressurePollMs: number
}

const DEFAULT_DEPENDENCIES: JobEventStreamDependencies = {
  readEvents: readOwnedJobEvents,
  readJob: readOwnedJob,
  wait,
  now: Date.now,
  initialPollIntervalMs: INITIAL_POLL_INTERVAL_MS,
  maxPollIntervalMs: MAX_POLL_INTERVAL_MS,
  statusRefreshIntervalMs: STATUS_REFRESH_INTERVAL_MS,
  heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
  admissionRenewIntervalMs: ADMISSION_RENEW_INTERVAL_MS,
  backpressureTimeoutMs: BACKPRESSURE_TIMEOUT_MS,
  backpressurePollMs: BACKPRESSURE_POLL_MS,
}

async function waitForCapacity(
  controller: ReadableStreamDefaultController<Uint8Array>,
  signal: AbortSignal,
  dependencies: JobEventStreamDependencies,
): Promise<boolean> {
  const started = dependencies.now()
  while ((controller.desiredSize ?? 0) <= 0) {
    if (dependencies.now() - started >= dependencies.backpressureTimeoutMs) return false
    await dependencies.wait(dependencies.backpressurePollMs, signal)
  }
  return true
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
  maxDurationMs?: number
  renewAdmission?: (signal?: AbortSignal) => Promise<boolean>
  onClosed?: () => void | Promise<void>
}, dependencyOverrides: Partial<JobEventStreamDependencies> = {}): ReadableStream<Uint8Array> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides }
  const stop = new AbortController()
  const deadline = AbortSignal.timeout(input.maxDurationMs ?? 15 * 60_000)
  const signal = AbortSignal.any([input.requestSignal, stop.signal, deadline])
  const encoder = new TextEncoder()
  let closed = false
  let admissionRelease: Promise<void> | null = null
  const releaseAdmission = (): Promise<void> => {
    admissionRelease ??= Promise.resolve().then(() => input.onClosed?.()).then(() => undefined).catch(() => undefined)
    return admissionRelease
  }
  signal.addEventListener('abort', () => { void releaseAdmission() }, { once: true })

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = async (value: string): Promise<boolean> => {
        if (closed || signal.aborted) return false
        if (!await waitForCapacity(controller, signal, dependencies)) return false
        controller.enqueue(encoder.encode(value))
        return true
      }
      let sequence = input.fromSequence
      let status = input.initialStatus
      let pollIntervalMs = dependencies.initialPollIntervalMs
      let lastHeartbeat = dependencies.now()
      let lastStatusRefresh = dependencies.now()
      let lastAdmissionRenewal = dependencies.now()
      try {
        while (!signal.aborted) {
          if (input.renewAdmission
            && dependencies.now() - lastAdmissionRenewal >= dependencies.admissionRenewIntervalMs) {
            if (!await input.renewAdmission(signal)) break
            lastAdmissionRenewal = dependencies.now()
          }
          const result = await dependencies.readEvents(
            input.client,
            input.principalId,
            input.jobId,
            sequence,
            200,
            signal,
          )
          if (!result.ok) {
            await send(`event: stream.error\ndata: ${JSON.stringify({
              schemaVersion: 1,
              jobId: input.jobId,
              code: 'DEPENDENCY_UNAVAILABLE',
              retryable: true,
            })}\n\n`)
            break
          }
          for (const event of result.value) {
            if (!await send(eventFrame(event))) {
              stop.abort(new Error('slow_consumer'))
              break
            }
            sequence = event.seq
            const terminalStatus = event.kind === 'job.terminal' ? event.payload.status : null
            if (typeof terminalStatus === 'string' && isTerminalJobStatus(terminalStatus)) {
              status = terminalStatus
            }
          }
          if (signal.aborted) break
          if (isTerminalJobStatus(status) && result.value.length === 0) break
          const now = dependencies.now()
          if (result.value.length === 0
            && now - lastStatusRefresh >= dependencies.statusRefreshIntervalMs) {
            const snapshot = await dependencies.readJob(
              input.client,
              input.principalId,
              input.jobId,
              signal,
            )
            if (!snapshot.ok) break
            status = snapshot.value.status
            lastStatusRefresh = now
          }
          if (now - lastHeartbeat >= dependencies.heartbeatIntervalMs) {
            if (!await send(`: heartbeat ${sequence}\n\n`)) {
              stop.abort(new Error('slow_consumer'))
              break
            }
            lastHeartbeat = dependencies.now()
          }
          if (!isTerminalJobStatus(status)) {
            if (result.value.length > 0) pollIntervalMs = dependencies.initialPollIntervalMs
            else pollIntervalMs = Math.min(dependencies.maxPollIntervalMs, pollIntervalMs * 2)
            await dependencies.wait(pollIntervalMs, signal)
          }
        }
      } catch {
        // Disconnect and cancellation are normal; the client resumes by sequence.
      } finally {
        closed = true
        await releaseAdmission()
        try { controller.close() } catch {}
      }
    },
    cancel(reason) {
      closed = true
      stop.abort(reason)
      return releaseAdmission()
    },
  })
}
