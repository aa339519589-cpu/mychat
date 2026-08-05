import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EnqueueJobError,
  enqueueJob,
  enqueueTimeoutPolicy,
  streamJobEvents,
} from '../components/literary-chat/job-stream-client'
import {
  enqueueJobStream,
} from '../components/literary-chat/live-job-stream-client'
import { enqueueJobUntilAccepted } from '../components/literary-chat/durable-job-enqueue'
import { RequestTimeoutError } from '../components/literary-chat/timed-json-fetch'

const conversationId = '99000000-0000-4000-8000-000000000001'
const generationId = '99000000-0000-4000-8000-000000000002'
const body = {
  conversationId,
  generationId,
  assistantMessageId: '99000000-0000-4000-8000-000000000003',
  userMessageId: '99000000-0000-4000-8000-000000000004',
  messages: [{ id: '99000000-0000-4000-8000-000000000004', role: 'user', content: 'hi' }],
}

function acceptedResponse(): Response {
  return Response.json({
    jobId: generationId,
    streamUrl: `/api/v1/jobs/${generationId}/events?from_seq=0`,
    status: 'queued',
  }, { status: 202 })
}

function emptyGenerationResponse(): Response {
  return Response.json({ job: null, streamUrl: null })
}

test('regeneration admission keeps the full server-authoritative processing window', () => {
  assert.deepEqual(enqueueTimeoutPolicy(body), {
    requestTimeoutMs: 15_000,
    reconcileTimeoutMs: 3_000,
    totalTimeoutMs: 30_000,
  })
  assert.deepEqual(enqueueTimeoutPolicy({
    ...body,
    turn: {
      schemaVersion: 2,
      operation: 'replace-from-user',
      expectedTailMessageId: body.assistantMessageId,
    },
  }), {
    requestTimeoutMs: 45_000,
    reconcileTimeoutMs: 10_000,
    totalTimeoutMs: 90_000,
  })
})

test('lost enqueue acknowledgement is reconciled without submitting a second turn', async () => {
  let postCalls = 0
  let generationReads = 0
  const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') {
      postCalls += 1
      throw new TypeError('Load failed')
    }
    generationReads += 1
    return Response.json({
      job: { id: generationId, status: 'queued' },
      streamUrl: `/api/v1/jobs/${generationId}/events?from_seq=0`,
    })
  }) as typeof fetch

  const accepted = await enqueueJob('/api/chat', body, new AbortController().signal, {
    fetcher,
    sleep: async () => { throw new Error('reconciliation should avoid retry delay') },
  })

  assert.equal(accepted.jobId, generationId)
  assert.equal(accepted.status, 'queued')
  assert.equal(postCalls, 1)
  assert.equal(generationReads, 1)
})

test('retryable admission outage reuses the exact serialized request and job id', async () => {
  const postedBodies: string[] = []
  const delays: number[] = []
  let postCalls = 0
  const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method !== 'POST') return emptyGenerationResponse()
    postCalls += 1
    postedBodies.push(String(init.body))
    if (postCalls === 1) return Response.json({
      error: {
        code: 'DEPENDENCY_UNAVAILABLE',
        message: '作业控制面暂时不可用',
        retryable: true,
        details: {},
      },
      request_id: 'request-1',
    }, { status: 503 })
    return acceptedResponse()
  }) as typeof fetch

  const accepted = await enqueueJob('/api/chat', body, new AbortController().signal, {
    fetcher,
    sleep: async milliseconds => { delays.push(milliseconds) },
  })

  assert.equal(accepted.jobId, generationId)
  assert.equal(postCalls, 2)
  assert.deepEqual(postedBodies, [JSON.stringify(body), JSON.stringify(body)])
  assert.deepEqual(delays, [250])
})

test('chat admission uses standard foreground fetch instead of Safari keepalive', async () => {
  let requestInit: RequestInit | undefined
  const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestInit = init
    return acceptedResponse()
  }) as typeof fetch

  const accepted = await enqueueJob('/api/chat', body, new AbortController().signal, { fetcher })

  assert.equal(accepted.jobId, generationId)
  assert.ok(requestInit)
  assert.equal('keepalive' in requestInit, false)
  assert.equal(requestInit.credentials, 'same-origin')
  assert.equal(requestInit.cache, 'no-store')
  assert.equal((requestInit.headers as Record<string, string>).Accept, 'application/json')
})

test('chat admission reuses its POST response as the first SSE connection', async () => {
  let requestInit: RequestInit | undefined
  const frames = [
    { jobId: generationId, seq: 1, kind: 'text.delta', payload: { text: '首' } },
    { jobId: generationId, seq: 2, kind: 'job.terminal', payload: { status: 'completed' } },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
  const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestInit = init
    return new Response(frames, { headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'X-MyChat-Job-Id': generationId,
      'X-MyChat-Job-Status': 'queued',
      'X-MyChat-Stream-Url': `/api/v1/jobs/${generationId}/live?from_seq=0`,
    } })
  }) as typeof fetch

  const opened = await enqueueJobStream(
    '/api/chat',
    body,
    new AbortController().signal,
    fetcher,
  )
  const events = []
  for await (const event of streamJobEvents(
    opened.accepted,
    new AbortController().signal,
    1_000,
    opened.response,
  )) events.push(event)

  assert.equal((requestInit?.headers as Record<string, string>).Accept,
    'text/event-stream, application/json')
  assert.equal(events[0]?.kind, 'text.delta')
  assert.equal(events[0]?.payload.text, '首')
  assert.equal(events[1]?.kind, 'job.terminal')
})

test('live admission accepts the legacy JSON response during a mixed rollout', async () => {
  const opened = await enqueueJobStream(
    '/api/chat',
    body,
    new AbortController().signal,
    (async () => acceptedResponse()) as typeof fetch,
  )

  assert.deepEqual(opened.accepted, {
    jobId: generationId,
    streamUrl: `/api/v1/jobs/${generationId}/events?from_seq=0`,
    status: 'queued',
  })
  assert.equal(opened.response, null)
})

test('live admission cancels an SSE response with invalid durable identity', async () => {
  let cancelled = false
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(': accepted\n\n')) },
    cancel() { cancelled = true },
  }), { headers: {
    'Content-Type': 'text/event-stream',
    'X-MyChat-Job-Id': 'wrong-job-id',
    'X-MyChat-Job-Status': 'queued',
    'X-MyChat-Stream-Url': '/api/v1/jobs/wrong-job-id/live',
  } })

  await assert.rejects(
    enqueueJobStream('/api/chat', body, new AbortController().signal,
      (async () => response) as typeof fetch),
    error => error instanceof EnqueueJobError
      && error.retryable
      && error.message === '流式入队响应无效',
  )
  assert.equal(cancelled, true)
})

test('live admission preserves retryable timeout, network, and server errors', async () => {
  for (const [thrown, expected] of [
    [new RequestTimeoutError(), '连接超时，请重试'],
    [new TypeError('Load failed'), '网络连接暂时中断，请稍后重试'],
  ] as const) {
    await assert.rejects(
      enqueueJobStream('/api/chat', body, new AbortController().signal,
        (async () => { throw thrown }) as typeof fetch),
      error => error instanceof EnqueueJobError
        && error.retryable
        && error.message === expected,
    )
  }

  await assert.rejects(
    enqueueJobStream('/api/chat', body, new AbortController().signal,
      (async () => Response.json({ error: { message: '控制面维护中' } }, { status: 503 })) as typeof fetch),
    error => error instanceof EnqueueJobError
      && error.retryable
      && error.message === '控制面维护中',
  )
})

test('live admission rejects malformed or mismatched legacy acknowledgements', async () => {
  for (const response of [
    new Response('not json', { headers: { 'Content-Type': 'application/json' } }),
    Response.json({ ...await acceptedResponse().json(), jobId: 'wrong-job-id' }, { status: 202 }),
  ]) {
    await assert.rejects(
      enqueueJobStream('/api/chat', body, new AbortController().signal,
        (async () => response) as typeof fetch),
      /作业入队响应无效/,
    )
  }
})

test('direct stream reconnects durably from the last delivered sequence', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  const initialFrames = [
    ': accepted',
    `data: ${JSON.stringify({ jobId: 7, seq: 1, kind: 'ignored', payload: {} })}`,
    `data: ${JSON.stringify({ jobId: generationId, seq: 1, kind: 'text.delta', payload: { text: '首' } })}`,
    `data: ${JSON.stringify({ jobId: generationId, seq: 1, kind: 'text.delta', payload: { text: '重复' } })}`,
    `data: ${JSON.stringify({ jobId: generationId, seq: 3, kind: 'text.delta', payload: { text: '缺口' } })}`,
  ].join('\n\n') + '\n\n'
  const terminalFrame = `data: ${JSON.stringify({
    jobId: generationId,
    seq: 2,
    kind: 'job.terminal',
    payload: { status: 'completed' },
  })}\n\n`
  let reconnectInput = ''
  let reconnectInit: RequestInit | undefined

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { origin: 'https://mychat.test' } },
  })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    reconnectInput = String(input)
    reconnectInit = init
    return new Response(terminalFrame, { headers: { 'Content-Type': 'text/event-stream' } })
  }) as typeof fetch

  try {
    const events = []
    for await (const event of streamJobEvents(
      { jobId: generationId, streamUrl: `/api/v1/jobs/${generationId}/events`, status: 'running' },
      new AbortController().signal,
      2_000,
      new Response(initialFrames, { headers: { 'Content-Type': 'text/event-stream' } }),
    )) events.push(event)

    assert.deepEqual(events.map(event => event.seq), [1, 2])
    assert.equal(reconnectInput, `/api/v1/jobs/${generationId}/events?from_seq=1`)
    assert.deepEqual(reconnectInit?.headers, { 'Last-Event-ID': '1' })
  } finally {
    globalThis.fetch = originalFetch
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
  }
})

test('permanent admission errors are not retried', async () => {
  let calls = 0
  const fetcher = (async () => {
    calls += 1
    return Response.json({
      error: {
        code: 'CONFLICT',
        message: '请求与现有作业冲突',
        retryable: false,
        details: {},
      },
      request_id: 'request-2',
    }, { status: 409 })
  }) as typeof fetch

  await assert.rejects(
    enqueueJob('/api/chat', body, new AbortController().signal, {
      fetcher,
      sleep: async () => { throw new Error('permanent errors must not sleep') },
    }),
    /请求与现有作业冲突/,
  )
  assert.equal(calls, 1)
})

test('exhausted Safari transport failures never expose the raw Load failed message', async () => {
  let postCalls = 0
  let generationReads = 0
  const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') {
      postCalls += 1
      throw new TypeError('Load failed')
    }
    generationReads += 1
    return emptyGenerationResponse()
  }) as typeof fetch

  await assert.rejects(
    enqueueJob('/api/chat', body, new AbortController().signal, {
      fetcher,
      sleep: async () => undefined,
    }),
    error => error instanceof Error
      && error.message === '网络连接暂时中断，请稍后重试'
      && !error.message.includes('Load failed'),
  )
  assert.equal(postCalls, 9)
  assert.equal(generationReads, 10)
})

test('hung browser admission request times out instead of leaving Thinking forever', async () => {
  let postCalls = 0
  const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method !== 'POST') return emptyGenerationResponse()
    postCalls += 1
    return new Promise<Response>((_resolve, reject) => {
      const requestSignal = init.signal
      if (!requestSignal) return
      const abort = () => reject(requestSignal.reason ?? new Error('aborted'))
      if (requestSignal.aborted) abort()
      else requestSignal.addEventListener('abort', abort, { once: true })
    })
  }) as typeof fetch

  const started = Date.now()
  await assert.rejects(
    enqueueJob('/api/chat', body, new AbortController().signal, {
      fetcher,
      sleep: async () => undefined,
      requestTimeoutMs: 5,
      reconcileTimeoutMs: 5,
      totalTimeoutMs: 18,
    }),
    /连接超时，请重试/,
  )

  assert.ok(postCalls >= 1)
  assert.ok(Date.now() - started < 1_000)
})

test('durable chat admission keeps retrying the same command after a foreground window expires', async () => {
  const receivedBodies: unknown[] = []
  const warnings: string[] = []
  const delays: number[] = []
  let attempts = 0
  const accepted = await enqueueJobUntilAccepted(
    '/api/chat',
    body,
    new AbortController().signal,
    error => warnings.push(error.message),
    {
      enqueue: async (_path, receivedBody) => {
        receivedBodies.push(receivedBody)
        attempts += 1
        if (attempts < 3) throw new EnqueueJobError('作业控制面暂时不可用', true)
        return {
          jobId: generationId,
          streamUrl: `/api/v1/jobs/${generationId}/events`,
          status: 'queued',
        }
      },
      sleep: async milliseconds => { delays.push(milliseconds) },
    },
  )

  assert.equal(accepted.jobId, generationId)
  assert.deepEqual(receivedBodies, [body, body, body])
  assert.deepEqual(warnings, ['作业控制面暂时不可用', '作业控制面暂时不可用'])
  assert.deepEqual(delays, [1_000, 2_000])
})

test('durable chat admission still stops on a permanent command error', async () => {
  await assert.rejects(
    enqueueJobUntilAccepted('/api/chat', body, new AbortController().signal, undefined, {
      enqueue: async () => { throw new EnqueueJobError('请求与现有作业冲突', false) },
      sleep: async () => { throw new Error('permanent errors must not sleep') },
    }),
    /请求与现有作业冲突/,
  )
})

test('durable chat admission remains explicitly cancellable while offline', async () => {
  const controller = new AbortController()
  await assert.rejects(
    enqueueJobUntilAccepted('/api/chat', body, controller.signal, undefined, {
      enqueue: async () => { throw new EnqueueJobError('网络连接暂时中断，请稍后重试', true) },
      sleep: async (_milliseconds, signal) => {
        controller.abort(new DOMException('Stopped', 'AbortError'))
        throw signal.reason
      },
    }),
    error => error instanceof DOMException && error.name === 'AbortError',
  )
})
