import { isRecord } from '@/lib/unknown-value'
import { parseSseEvent, splitSseEvents } from './stream-events'
import { fetchJsonWithTimeout, RequestTimeoutError } from './timed-json-fetch'

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

type EnqueueJobDependencies = {
  fetcher: typeof fetch
  sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>
  now: () => number
  requestTimeoutMs: number
  reconcileTimeoutMs: number
  totalTimeoutMs: number
}

type EnqueueAttempt = {
  accepted: AcceptedJob | null
  error: Error | null
  retryable: boolean
  retryAfterMs: number
}

const ENQUEUE_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000, 8_000, 8_000, 8_000] as const
const RETRYABLE_ENQUEUE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504])
const ENQUEUE_REQUEST_TIMEOUT_MS = 15_000
const RECONCILE_REQUEST_TIMEOUT_MS = 3_000
const ENQUEUE_TOTAL_TIMEOUT_MS = 30_000

function responseError(value: unknown, status: number): string {
  if (!isRecord(value)) return `请求失败（${status}）`
  if (typeof value.error === 'string') return value.error
  if (isRecord(value.error) && typeof value.error.message === 'string') return value.error.message
  return `请求失败（${status}）`
}

function acceptedJob(value: unknown): AcceptedJob | null {
  if (!isRecord(value) || typeof value.jobId !== 'string'
    || typeof value.streamUrl !== 'string' || typeof value.status !== 'string') return null
  return { jobId: value.jobId, streamUrl: value.streamUrl, status: value.status }
}

function reconciledJob(value: unknown, expectedJobId: string): AcceptedJob | null {
  if (!isRecord(value) || !isRecord(value.job) || typeof value.streamUrl !== 'string') return null
  const job = value.job
  if (job.id !== expectedJobId || typeof job.status !== 'string') return null
  return { jobId: expectedJobId, streamUrl: value.streamUrl, status: job.status }
}

function retryablePayload(value: unknown): boolean {
  return isRecord(value) && isRecord(value.error) && value.error.retryable === true
}

function retryAfterMilliseconds(response: Response): number {
  const seconds = Number(response.headers.get('Retry-After'))
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(15_000, seconds * 1_000) : 0
}

function durableIdentity(body: unknown): { conversationId: string; generationId: string } | null {
  if (!isRecord(body) || typeof body.conversationId !== 'string'
    || typeof body.generationId !== 'string') return null
  return { conversationId: body.conversationId, generationId: body.generationId }
}

function networkError(): Error {
  return new Error('网络连接暂时中断，请稍后重试')
}

function timeoutError(): Error {
  return new Error('连接超时，请重试')
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

const DEFAULT_ENQUEUE_DEPENDENCIES: EnqueueJobDependencies = {
  fetcher: fetch,
  sleep: abortableWait,
  now: Date.now,
  requestTimeoutMs: ENQUEUE_REQUEST_TIMEOUT_MS,
  reconcileTimeoutMs: RECONCILE_REQUEST_TIMEOUT_MS,
  totalTimeoutMs: ENQUEUE_TOTAL_TIMEOUT_MS,
}

async function enqueueAttempt(
  path: string,
  serializedBody: string,
  signal: AbortSignal,
  fetcher: typeof fetch,
  timeoutMs: number,
): Promise<EnqueueAttempt> {
  try {
    const { response, payload } = await fetchJsonWithTimeout(fetcher, path, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: serializedBody,
    }, signal, timeoutMs)
    if (!response.ok) return {
      accepted: null,
      error: new Error(responseError(payload, response.status)),
      retryable: retryablePayload(payload) || RETRYABLE_ENQUEUE_STATUSES.has(response.status),
      retryAfterMs: retryAfterMilliseconds(response),
    }
    const accepted = acceptedJob(payload)
    return accepted ? {
      accepted,
      error: null,
      retryable: false,
      retryAfterMs: 0,
    } : {
      accepted: null,
      error: new Error('作业入队响应无效'),
      retryable: true,
      retryAfterMs: 0,
    }
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error
    return {
      accepted: null,
      error: error instanceof RequestTimeoutError ? timeoutError() : networkError(),
      retryable: true,
      retryAfterMs: 0,
    }
  }
}

async function reconcileAcceptedJob(
  body: unknown,
  signal: AbortSignal,
  fetcher: typeof fetch,
  timeoutMs: number,
): Promise<AcceptedJob | null> {
  const identity = durableIdentity(body)
  if (!identity) return null
  try {
    const { response, payload } = await fetchJsonWithTimeout(
      fetcher,
      `/api/v1/conversations/${encodeURIComponent(identity.conversationId)}/generation`,
      { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } },
      signal,
      timeoutMs,
    )
    if (!response.ok) return null
    return reconciledJob(payload, identity.generationId)
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error
    return null
  }
}

function remainingMilliseconds(deadline: number, now: () => number): number {
  return Math.max(0, deadline - now())
}

export async function enqueueJob(
  path: string,
  body: unknown,
  signal: AbortSignal,
  dependencyOverrides: Partial<EnqueueJobDependencies> = {},
): Promise<AcceptedJob> {
  const dependencies = { ...DEFAULT_ENQUEUE_DEPENDENCIES, ...dependencyOverrides }
  const serializedBody = JSON.stringify(body)
  const deadline = dependencies.now() + Math.max(1, dependencies.totalTimeoutMs)
  let lastError = networkError()

  for (let attempt = 0; attempt <= ENQUEUE_RETRY_DELAYS_MS.length; attempt += 1) {
    const attemptBudget = remainingMilliseconds(deadline, dependencies.now)
    if (attemptBudget <= 0) break
    const result = await enqueueAttempt(
      path,
      serializedBody,
      signal,
      dependencies.fetcher,
      Math.min(dependencies.requestTimeoutMs, attemptBudget),
    )
    if (result.accepted) return result.accepted
    if (result.error) lastError = result.error
    if (!result.retryable) throw lastError

    const reconcileBudget = remainingMilliseconds(deadline, dependencies.now)
    if (reconcileBudget > 0) {
      const reconciled = await reconcileAcceptedJob(
        body,
        signal,
        dependencies.fetcher,
        Math.min(dependencies.reconcileTimeoutMs, reconcileBudget),
      )
      if (reconciled) return reconciled
    }

    const scheduledDelay = ENQUEUE_RETRY_DELAYS_MS[attempt]
    const waitBudget = remainingMilliseconds(deadline, dependencies.now)
    if (scheduledDelay === undefined || waitBudget <= 0) break
    await dependencies.sleep(
      Math.min(Math.max(scheduledDelay, result.retryAfterMs), waitBudget),
      signal,
    )
  }

  const finalBudget = remainingMilliseconds(deadline, dependencies.now)
  if (finalBudget > 0) {
    const reconciled = await reconcileAcceptedJob(
      body,
      signal,
      dependencies.fetcher,
      Math.min(dependencies.reconcileTimeoutMs, finalBudget),
    )
    if (reconciled) return reconciled
  }
  throw lastError
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
        credentials: 'same-origin',
        cache: 'no-store',
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
