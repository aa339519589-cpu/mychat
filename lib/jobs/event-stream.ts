import type { SupabaseClient } from '@/lib/supabase/types'
import { isTerminalJobStatus, type JobStatus, type JsonObject } from './contracts'
import {
  readOwnedJob,
  readOwnedJobEvents,
  type PublicJobEvent,
  type PublicJobSnapshot,
} from './read-model'

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

function terminalPayload(snapshot: PublicJobSnapshot): JsonObject {
  const payload: JsonObject = { status: snapshot.status }
  if (snapshot.result !== null) payload.result = snapshot.result
  if (snapshot.status !== 'completed') {
    const error = snapshot.errorCode ?? '生成未完成'
    payload.errorCode = error
    payload.error = error
  }
  return payload
}

function syntheticTerminalEvent(snapshot: PublicJobSnapshot, sequence: number): PublicJobEvent {
  return {
    id: `synthetic-terminal:${snapshot.id}:${sequence}`,
    jobId: snapshot.id,
    seq: sequence,
    kind: 'job.terminal',
    schemaVersion: 1,
    payload: terminalPayload(snapshot),
    createdAt: snapshot.terminalAt ?? snapshot.updatedAt,
  }
}

function streamErrorFrame(jobId: string): string {
  return `event: stream.error\ndata: ${JSON.stringify({
    schemaVersion: 1,
    jobId,
    code: 'DEPENDENCY_UNAVAILABLE',
    retryable: true,
  })}\n\n`
}

type StreamInput = {
  client: SupabaseClient
  principalId: string
  jobId: string
  fromSequence: number
  initialStatus: JobStatus
  requestSignal: AbortSignal
  maxDurationMs?: number
  renewAdmission?: (signal?: AbortSignal) => Promise<boolean>
  onClosed?: () => void | Promise<void>
}

type StreamSend = (value: string) => Promise<boolean>

class JobEventStreamRunner {
  private sequence: number
  private status: JobStatus
  private terminalDelivered = false
  private pollIntervalMs: number
  private lastHeartbeat: number
  private lastStatusRefresh: number
  private lastAdmissionRenewal: number

  constructor(
    private readonly input: StreamInput,
    private readonly dependencies: JobEventStreamDependencies,
    private readonly signal: AbortSignal,
    private readonly stop: AbortController,
    private readonly send: StreamSend,
  ) {
    this.sequence = input.fromSequence
    this.status = input.initialStatus
    this.pollIntervalMs = dependencies.initialPollIntervalMs
    const now = dependencies.now()
    this.lastHeartbeat = now
    this.lastStatusRefresh = now
    this.lastAdmissionRenewal = now
  }

  async run(): Promise<void> {
    while (!this.signal.aborted) {
      if (!await this.renewAdmission()) return
      const events = await this.readEvents()
      if (events === null || !await this.forwardEvents(events)) return
      if (this.signal.aborted || await this.finishTerminal(events.length)) return
      const now = this.dependencies.now()
      if (!await this.refreshStatus(now, events.length)) return
      if (!await this.sendHeartbeat(now)) return
      await this.waitForNextPoll(events.length)
    }
  }

  private async renewAdmission(): Promise<boolean> {
    if (!this.input.renewAdmission) return true
    const now = this.dependencies.now()
    if (now - this.lastAdmissionRenewal < this.dependencies.admissionRenewIntervalMs) return true
    const renewed = await this.input.renewAdmission(this.signal)
    if (renewed) this.lastAdmissionRenewal = now
    return renewed
  }

  private async readEvents(): Promise<PublicJobEvent[] | null> {
    const result = await this.dependencies.readEvents(
      this.input.client,
      this.input.principalId,
      this.input.jobId,
      this.sequence,
      200,
      this.signal,
    )
    if (result.ok) return result.value
    await this.send(streamErrorFrame(this.input.jobId))
    return null
  }

  private async forwardEvents(events: PublicJobEvent[]): Promise<boolean> {
    for (const event of events) {
      if (!await this.send(eventFrame(event))) {
        this.stop.abort(new Error('slow_consumer'))
        return false
      }
      this.sequence = event.seq
      const terminalStatus = event.kind === 'job.terminal' ? event.payload.status : null
      if (typeof terminalStatus === 'string' && isTerminalJobStatus(terminalStatus)) {
        this.status = terminalStatus
        this.terminalDelivered = true
      }
    }
    return true
  }

  private async finishTerminal(eventCount: number): Promise<boolean> {
    if (!isTerminalJobStatus(this.status) || eventCount > 0) return false
    if (this.terminalDelivered) return true
    const snapshot = await this.readSnapshot()
    if (!snapshot) return true
    this.status = snapshot.status
    if (!isTerminalJobStatus(this.status)) return false
    const terminal = syntheticTerminalEvent(snapshot, this.sequence + 1)
    if (!await this.send(eventFrame(terminal))) {
      this.stop.abort(new Error('slow_consumer'))
      return true
    }
    this.sequence = terminal.seq
    this.terminalDelivered = true
    return true
  }

  private async refreshStatus(now: number, eventCount: number): Promise<boolean> {
    if (eventCount > 0
      || now - this.lastStatusRefresh < this.dependencies.statusRefreshIntervalMs) return true
    const snapshot = await this.readSnapshot()
    if (!snapshot) return false
    this.status = snapshot.status
    this.lastStatusRefresh = now
    return true
  }

  private async readSnapshot(): Promise<PublicJobSnapshot | null> {
    const snapshot = await this.dependencies.readJob(
      this.input.client,
      this.input.principalId,
      this.input.jobId,
      this.signal,
    )
    if (snapshot.ok) return snapshot.value
    await this.send(streamErrorFrame(this.input.jobId))
    return null
  }

  private async sendHeartbeat(now: number): Promise<boolean> {
    if (now - this.lastHeartbeat < this.dependencies.heartbeatIntervalMs) return true
    if (await this.send(`: heartbeat ${this.sequence}\n\n`)) {
      this.lastHeartbeat = this.dependencies.now()
      return true
    }
    this.stop.abort(new Error('slow_consumer'))
    return false
  }

  private async waitForNextPoll(eventCount: number): Promise<void> {
    if (isTerminalJobStatus(this.status)) return
    this.pollIntervalMs = eventCount > 0
      ? this.dependencies.initialPollIntervalMs
      : Math.min(this.dependencies.maxPollIntervalMs, this.pollIntervalMs * 2)
    await this.dependencies.wait(this.pollIntervalMs, this.signal)
  }
}

export function createJobEventStream(
  input: StreamInput,
  dependencyOverrides: Partial<JobEventStreamDependencies> = {},
): ReadableStream<Uint8Array> {
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
      const send: StreamSend = async value => {
        if (closed || signal.aborted) return false
        if (!await waitForCapacity(controller, signal, dependencies)) return false
        controller.enqueue(encoder.encode(value))
        return true
      }
      try {
        await new JobEventStreamRunner(input, dependencies, signal, stop, send).run()
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
