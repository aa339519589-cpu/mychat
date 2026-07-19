import assert from 'node:assert/strict'
import test from 'node:test'
import { enqueueJob } from '../components/literary-chat/job-stream-client'

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
