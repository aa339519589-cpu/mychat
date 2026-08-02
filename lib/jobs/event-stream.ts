import type { SupabaseClient } from '@/lib/supabase/types'
import { isTerminalJobStatus, type JobStatus } from './contracts'
import { readOwnedJob, readOwnedJobEvents, type PublicJobEvent } from './read-model'

const INITIAL_POLL_INTERVAL_MS = 250
const MAX_POLL_INTERVAL_MS = 2_000
const CHAT_INITIAL_POLL_INTERVAL_MS = 40
const CHAT_MAX_POLL_INTERVAL_MS = 120
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

type JobEventStreamInput = {
  client: SupabaseClient
  principalId: string
  jobId: string
  jobType?: string
  fromSequence: number
  initialStatus: JobStatus
  requestSignal: AbortSignal
  maxDurationMs?: number
  renewAdmission?: (signal?: AbortSignal) => Promise<boolean>
  onClosed?: () => void | Promise<void>
}

type PollBounds = { initial: number; maximum: number; lowLatency: boolean }

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

function eventFrame(event: PublicJobEvent): string {
  return `id: ${event.seq}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`
}

function pollBounds(
  jobType: string | undefined,
  dependencies: JobEventStreamDependencies,
): PollBounds {
  if (jobType !== 'chat.generation') return {
    initial: dependencies.initialPollIntervalMs,
    maximum: dependencies.maxPollIntervalMs,
    lowLatency: false,
  }
  return {
    initial: Math.min(dependencies.initialPollIntervalMs, CHAT_INITIAL_POLL_INTERVAL_MS),
    maximum: Math.min(dependencies.maxPollIntervalMs, CHAT_MAX_POLL_INTERVAL_MS),
    lowLatency: true,
  }
}

function nextPollInterval(current: number, hadEvents: boolean, bounds: PollBounds): number {
  if (hadEvents) return bounds.initial
  return Math.min(bounds.maximum, bounds.lowLatency ? current + bounds.initial : current * 2)
}

class JobEventStreamRuntime {
  private readonly encoder = new TextEncoder()
  private readonly stop = new AbortController()
  private readonly signal: AbortSignal
  private readonly polling: PollBounds
  private sequence: number
  private status: JobStatus
  private pollIntervalMs: number
  private lastHeartbeat: number
  private lastStatusRefresh: number
  private lastAdmissionRenewal: number
  private closed = false
  private admissionRelease: Promise<void> | null = null

  constructor(
    private readonly controller: ReadableStreamDefaultController<Uint8Array>,
    private readonly input: JobEventStreamInput,
    private readonly dependencies: JobEventStreamDependencies,
  ) {
    const deadline = AbortSignal.timeout(input.maxDurationMs ?? 15 * 60_000)
    this.signal = AbortSignal.any([input.requestSignal, this.stop.signal, deadline])
    this.polling = pollBounds(input.jobType, dependencies)
    this.sequence = input.fromSequence
    this.status = input.initialStatus
    this.pollIntervalMs = this.polling.initial
    const now = dependencies.now()
    this.lastHeartbeat = now
    this.lastStatusRefresh = now
    this.lastAdmissionRenewal = now
    this.signal.addEventListener('abort', () => { void this.releaseAdmission() }, { once: true })
  }

  async run(): Promise<void> {
    try {
      while (!this.signal.aborted) {
        if (!await this.renewAdmission()) break
        const events = await this.readEvents()
        if (!events) break
        if (!await this.sendEvents(events)) break
        if (await this.shouldStop(events)) break
        if (!await this.sendHeartbeat()) break
        await this.waitForNextPoll(events.length > 0)
      }
    } catch {
      // Disconnect and cancellation are normal; the client resumes by sequence.
    } finally {
      await this.close()
    }
  }

  cancel(reason: unknown): Promise<void> {
    this.closed = true
    this.stop.abort(reason)
    return this.releaseAdmission()
  }

  private async send(value: string): Promise<boolean> {
    if (this.closed || this.signal.aborted) return false
    if (!await waitForCapacity(this.controller, this.signal, this.dependencies)) return false
    this.controller.enqueue(this.encoder.encode(value))
    return true
  }

  private async renewAdmission(): Promise<boolean> {
    const renew = this.input.renewAdmission
    if (!renew) return true
    if (this.dependencies.now() - this.lastAdmissionRenewal
      < this.dependencies.admissionRenewIntervalMs) return true
    if (!await renew(this.signal)) return false
    this.lastAdmissionRenewal = this.dependencies.now()
    return true
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
    await this.send(`event: stream.error\ndata: ${JSON.stringify({
      schemaVersion: 1,
      jobId: this.input.jobId,
      code: 'DEPENDENCY_UNAVAILABLE',
      retryable: true,
    })}\n\n`)
    return null
  }

  private async sendEvents(events: PublicJobEvent[]): Promise<boolean> {
    for (const event of events) {
      if (!await this.send(eventFrame(event))) {
        this.stop.abort(new Error('slow_consumer'))
        return false
      }
      this.sequence = event.seq
      const terminalStatus = event.kind === 'job.terminal' ? event.payload.status : null
      if (typeof terminalStatus === 'string' && isTerminalJobStatus(terminalStatus)) {
        this.status = terminalStatus
      }
    }
    return true
  }

  private async shouldStop(events: PublicJobEvent[]): Promise<boolean> {
    if (this.signal.aborted) return true
    if (isTerminalJobStatus(this.status) && events.length === 0) return true
    if (events.length > 0) return false
    if (this.dependencies.now() - this.lastStatusRefresh
      < this.dependencies.statusRefreshIntervalMs) return false
    const snapshot = await this.dependencies.readJob(
      this.input.client,
      this.input.principalId,
      this.input.jobId,
      this.signal,
    )
    if (!snapshot.ok) return true
    this.status = snapshot.value.status
    this.lastStatusRefresh = this.dependencies.now()
    return false
  }

  private async sendHeartbeat(): Promise<boolean> {
    if (this.dependencies.now() - this.lastHeartbeat < this.dependencies.heartbeatIntervalMs) {
      return true
    }
    if (!await this.send(`: heartbeat ${this.sequence}\n\n`)) {
      this.stop.abort(new Error('slow_consumer'))
      return false
    }
    this.lastHeartbeat = this.dependencies.now()
    return true
  }

  private async waitForNextPoll(hadEvents: boolean): Promise<void> {
    if (isTerminalJobStatus(this.status)) return
    this.pollIntervalMs = nextPollInterval(this.pollIntervalMs, hadEvents, this.polling)
    await this.dependencies.wait(this.pollIntervalMs, this.signal)
  }

  private async close(): Promise<void> {
    this.closed = true
    await this.releaseAdmission()
    try { this.controller.close() } catch {}
  }

  private releaseAdmission(): Promise<void> {
    this.admissionRelease ??= Promise.resolve()
      .then(() => this.input.onClosed?.())
      .then(() => undefined)
      .catch(() => undefined)
    return this.admissionRelease
  }
}

export function createJobEventStream(
  input: JobEventStreamInput,
  dependencyOverrides: Partial<JobEventStreamDependencies> = {},
): ReadableStream<Uint8Array> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides }
  let runtime: JobEventStreamRuntime | null = null
  return new ReadableStream<Uint8Array>({
    start(controller) {
      runtime = new JobEventStreamRuntime(controller, input, dependencies)
      return runtime.run()
    },
    cancel(reason) {
      return runtime?.cancel(reason)
    },
  })
}
