import assert from 'node:assert/strict'
import test from 'node:test'
import { acceptedLiveChatResponse } from '../lib/chat/live-response'

const jobId = '98000000-0000-4000-8000-000000000001'

test('accepted chat POST flushes SSE headers before live-stream setup finishes', async () => {
  let finishRead: (() => void) | undefined
  const waitingRead = new Promise<void>(resolve => { finishRead = resolve })
  const response = acceptedLiveChatResponse({
    request: new Request('http://localhost/api/chat', { method: 'POST' }),
    client: {} as never,
    principalId: '98000000-0000-4000-8000-000000000002',
    address: '127.0.0.1',
    accepted: {
      jobId,
      status: 'queued',
      created: true,
      streamUrl: `/api/v1/jobs/${jobId}/live?from_seq=0`,
    },
  }, {
    readJob: async () => {
      await waitingRead
      return { ok: false, kind: 'unavailable' }
    },
    acquireStream: async () => ({
      acquired: false,
      kind: 'unavailable',
      retryAfterSeconds: 1,
    }),
  })

  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)
  assert.equal(response.headers.get('X-MyChat-Job-Id'), jobId)

  const reader = response.body?.getReader()
  assert.ok(reader)
  const first = await reader.read()
  assert.equal(new TextDecoder().decode(first.value), ': accepted\n\n')
  finishRead?.()
  assert.equal((await reader.read()).done, true)
})

test('accepted chat POST forwards the live stream on the same response', async () => {
  let released = 0
  const liveFrame = new TextEncoder().encode('data: {"kind":"text.delta"}\n\n')
  const response = acceptedLiveChatResponse({
    request: new Request('http://localhost/api/chat', { method: 'POST' }),
    client: {} as never,
    principalId: '98000000-0000-4000-8000-000000000002',
    address: '127.0.0.1',
    accepted: {
      jobId,
      status: 'queued',
      created: true,
      streamUrl: `/api/v1/jobs/${jobId}/live?from_seq=0`,
    },
  }, {
    readJob: async () => ({ ok: true, value: {} as never }),
    acquireStream: async () => ({
      acquired: true,
      lease: {
        id: 'stream-1',
        hardExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        maxDurationMs: 60_000,
        renew: async () => true,
        release: async () => { released += 1 },
      },
    }),
    createStream: options => new ReadableStream({
      start(controller) {
        controller.enqueue(liveFrame)
        controller.close()
        void options.onClosed?.()
      },
    }),
  })

  const reader = response.body?.getReader()
  assert.ok(reader)
  assert.equal(new TextDecoder().decode((await reader.read()).value), ': accepted\n\n')
  assert.equal(new TextDecoder().decode((await reader.read()).value),
    'data: {"kind":"text.delta"}\n\n')
  assert.equal((await reader.read()).done, true)
  assert.equal(released, 1)
})
