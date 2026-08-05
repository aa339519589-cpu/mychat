import { isRecord } from '@/lib/unknown-value'
import {
  EnqueueJobError,
  type AcceptedJob,
} from './job-stream-client'
import { enqueueTimeoutPolicy } from './job-enqueue-policy'
import { fetchWithTimeout, RequestTimeoutError } from './timed-json-fetch'

export type AcceptedJobStream = {
  accepted: AcceptedJob
  response: Response | null
}

const RETRYABLE_ENQUEUE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504])

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

function acceptedStream(response: Response, expectedJobId: string | null): AcceptedJob | null {
  const jobId = response.headers.get('X-MyChat-Job-Id')
  const streamUrl = response.headers.get('X-MyChat-Stream-Url')
  const status = response.headers.get('X-MyChat-Job-Status')
  if (!jobId || !streamUrl || !status || (expectedJobId && jobId !== expectedJobId)) return null
  return { jobId, streamUrl, status }
}

function retryablePayload(value: unknown): boolean {
  return isRecord(value) && isRecord(value.error) && value.error.retryable === true
}

function durableGenerationId(body: unknown): string | null {
  return isRecord(body) && typeof body.generationId === 'string' ? body.generationId : null
}

/** Opens the admission POST as the initial SSE stream. JSON remains accepted
 * for mixed-revision rollout and becomes the normal durable GET fallback. */
export async function enqueueJobStream(
  path: string,
  body: unknown,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<AcceptedJobStream> {
  let response: Response
  try {
    response = await fetchWithTimeout(fetcher, path, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        Accept: 'text/event-stream, application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }, signal, enqueueTimeoutPolicy(body).requestTimeoutMs)
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error
    throw new EnqueueJobError(
      error instanceof RequestTimeoutError ? '连接超时，请重试' : '网络连接暂时中断，请稍后重试',
      true,
    )
  }

  return acceptedResponse(response, durableGenerationId(body))
}

async function acceptedResponse(
  response: Response,
  expectedJobId: string | null,
): Promise<AcceptedJobStream> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (response.ok && contentType.includes('text/event-stream')) {
    const accepted = acceptedStream(response, expectedJobId)
    if (!accepted) {
      await response.body?.cancel().catch(() => undefined)
      throw new EnqueueJobError('流式入队响应无效', true)
    }
    return { accepted, response }
  }

  const payload: unknown = await response.json().catch(() => null)
  if (!response.ok) throw new EnqueueJobError(
    responseError(payload, response.status),
    retryablePayload(payload) || RETRYABLE_ENQUEUE_STATUSES.has(response.status),
  )
  const accepted = acceptedJob(payload)
  if (!accepted || (expectedJobId && accepted.jobId !== expectedJobId)) {
    throw new EnqueueJobError('作业入队响应无效', true)
  }
  return { accepted, response: null }
}
