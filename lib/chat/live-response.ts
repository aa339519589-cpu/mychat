import type { SupabaseClient } from '@/lib/supabase/types'
import { createLiveJobEventStream } from '@/lib/jobs/live-event-stream'
import { readOwnedJob } from '@/lib/jobs/read-model'
import {
  acquireJobEventStreamLease,
  type JobEventStreamAdmission,
} from '@/lib/jobs/stream-admission'

const encoder = new TextEncoder()

type LiveResponseDependencies = {
  readJob: typeof readOwnedJob
  acquireStream: typeof acquireJobEventStreamLease
  createStream: typeof createLiveJobEventStream
}

const DEFAULT_DEPENDENCIES: LiveResponseDependencies = {
  readJob: readOwnedJob,
  acquireStream: acquireJobEventStreamLease,
  createStream: createLiveJobEventStream,
}

export type AcceptedLiveChat = {
  jobId: string
  status: string
  created: boolean
  streamUrl: string
}

function acceptedHeaders(accepted: AcceptedLiveChat): Headers {
  return new Headers({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-MyChat-Job-Id': accepted.jobId,
    'X-MyChat-Job-Status': accepted.status,
    'X-MyChat-Job-Created': accepted.created ? '1' : '0',
    'X-MyChat-Stream-Url': accepted.streamUrl,
  })
}

function acquired(
  value: JobEventStreamAdmission,
): value is Extract<JobEventStreamAdmission, { acquired: true }> {
  return value.acquired
}

/**
 * Reuses the admission POST as the browser's live SSE connection. The accepted
 * comment flushes response headers immediately; durable GET reconnect remains
 * the fallback if setup or the connection is interrupted.
 */
export function acceptedLiveChatResponse(input: {
  request: Request
  client: SupabaseClient
  principalId: string
  address: string
  accepted: AcceptedLiveChat
}, dependencyOverrides: Partial<LiveResponseDependencies> = {}): Response {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides }
  const lifetime = new AbortController()
  const signal = AbortSignal.any([input.request.signal, lifetime.signal])
  let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | null = null

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(': accepted\n\n'))
      void (async () => {
        const [job, admission] = await Promise.all([
          dependencies.readJob(
            input.client,
            input.principalId,
            input.accepted.jobId,
            signal,
          ),
          dependencies.acquireStream({
            principalId: input.principalId,
            jobId: input.accepted.jobId,
            address: input.address,
            signal,
          }),
        ])
        if (!job.ok || !acquired(admission) || signal.aborted) {
          if (acquired(admission)) await admission.lease.release()
          return
        }

        let upstream: ReadableStream<Uint8Array>
        try {
          upstream = dependencies.createStream({
            client: input.client,
            principalId: input.principalId,
            jobId: input.accepted.jobId,
            fromSequence: 0,
            initialJob: job.value,
            requestSignal: signal,
            maxDurationMs: admission.lease.maxDurationMs,
            renewAdmission: admission.lease.renew,
            onClosed: admission.lease.release,
          })
        } catch (error) {
          await admission.lease.release()
          throw error
        }
        upstreamReader = upstream.getReader()
        while (!signal.aborted) {
          const chunk = await upstreamReader.read()
          if (chunk.done) break
          controller.enqueue(chunk.value)
        }
      })().catch(() => undefined).finally(() => {
        try { controller.close() } catch {}
      })
    },
    cancel(reason) {
      lifetime.abort(reason)
      void upstreamReader?.cancel(reason).catch(() => undefined)
    },
  })

  return new Response(body, { status: 200, headers: acceptedHeaders(input.accepted) })
}
