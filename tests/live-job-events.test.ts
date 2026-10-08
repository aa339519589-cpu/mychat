import assert from 'node:assert/strict'
import test from 'node:test'

import {
  LiveJobPublisher,
  applyOffsetDelta,
  liveJobChannelName,
  parseLiveJobEvent,
} from '../lib/jobs/live-events'

const JOB_ID = '00000000-0000-4000-8000-000000000001'
const CHANNEL_HASH_INPUT = 'test key for channel hashing only'

test('the first answer character bypasses a saturated reasoning broadcast queue', async () => {
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const sent: Array<{ kind: string; payload: { text?: string } }> = []
  const channel = {
    subscribe: () => channel,
    httpSend: async (_name: string, event: { kind: string; payload: { text?: string } }) => {
      sent.push(event)
      await blocked
      return 'ok'
    },
  }
  const publisher = new LiveJobPublisher({ channel: () => channel, removeChannel: async () => undefined } as never,
    JOB_ID, CHANNEL_HASH_INPUT)
  publisher.start()
  for (let index = 0; index < 10; index++) publisher.publish({ kind: 'thinking.delta', offset: index, payload: { thinking: '.' } })
  assert.equal(sent.length, 8)
  publisher.publish({ kind: 'text.delta', offset: 0, payload: { text: '你' } })
  assert.equal(sent.at(-1)?.payload.text, '你', 'First text must be sent synchronously without a timer, batch, or ACK')
  assert.equal(sent.length, 9, 'Exactly one reserved first-text slot')
  release()
  await publisher.close()
})

test('live job channel names are stable and do not expose job ids', () => {
  const first = liveJobChannelName(JOB_ID, CHANNEL_HASH_INPUT)
  const second = liveJobChannelName(JOB_ID, CHANNEL_HASH_INPUT)
  assert.equal(first, second)
  assert.ok(first?.startsWith('job-live:'))
  assert.equal(first?.includes(JOB_ID), false)
  assert.equal(liveJobChannelName(JOB_ID, ''), null)
})

test('offset deltas append, trim overlap and report gaps', () => {
  assert.deepEqual(applyOffsetDelta('abc', 3, 'def'), {
    next: 'abcdef', appended: 'def', gap: false,
  })
  assert.deepEqual(applyOffsetDelta('abcdef', 3, 'defghi'), {
    next: 'abcdefghi', appended: 'ghi', gap: false,
  })
  assert.deepEqual(applyOffsetDelta('abcdef', 3, 'def'), {
    next: 'abcdef', appended: '', gap: false,
  })
  assert.deepEqual(applyOffsetDelta('abc', 5, 'x'), {
    next: 'abc', appended: '', gap: true,
  })
})

test('live event parser rejects malformed broadcast payloads', () => {
  assert.deepEqual(parseLiveJobEvent({
    revision: 1,
    kind: 'text.delta',
    offset: 0,
    payload: { text: 'hello' },
  }), {
    revision: 1,
    kind: 'text.delta',
    offset: 0,
    payload: { text: 'hello' },
  })
  assert.equal(parseLiveJobEvent({ revision: 0, kind: 'text.delta', payload: {} }), null)
  assert.equal(parseLiveJobEvent({ revision: 1, kind: 'text.delta', offset: -1, payload: {} }), null)
})

test('publisher sends adjacent provider deltas separately without subscribing', async () => {
  const sent: unknown[] = []
  const channel = {
    subscribe: () => channel,
    httpSend: async (_event: string, payload: unknown) => {
      sent.push(payload)
      return 'ok'
    },
  }
  const client = {
    channel: () => channel,
    removeChannel: async () => undefined,
  }
  const publisher = new LiveJobPublisher(client as never, JOB_ID, CHANNEL_HASH_INPUT)
  publisher.start()
  publisher.publish({ kind: 'text.delta', offset: 0, payload: { text: '你' } })
  publisher.publish({ kind: 'text.delta', offset: 1, payload: { text: '好' } })
  await publisher.close()

  assert.equal(sent.length, 2)
  assert.deepEqual(sent.map(value => {
    const { streamId: _streamId, ...event } = value as Record<string, unknown>
    return event
  }), [
    { revision: 1, kind: 'text.delta', offset: 0, payload: { text: '你' } },
    { revision: 2, kind: 'text.delta', offset: 1, payload: { text: '好' } },
  ])
})

test('subscribed relay sends each small delta through the ordered socket without HTTP latency', async () => {
  let status: ((value: string) => void) | undefined
  const socket: unknown[] = []
  const http: unknown[] = []
  const channel = {
    subscribe: (callback: (value: string) => void) => { status = callback; return channel },
    send: async (value: { payload: unknown }) => { socket.push(value.payload); return 'ok' },
    httpSend: async (_event: string, payload: unknown) => { http.push(payload) },
  }
  const client = { channel: () => channel, removeChannel: async () => undefined }
  const publisher = new LiveJobPublisher(client as never, JOB_ID, CHANNEL_HASH_INPUT)
  publisher.start()
  status?.('SUBSCRIBED')
  const source = '中文 English **Markdown** 👨‍👩‍👧‍👦'.repeat(10)
  let offset = 0
  for (const text of source) {
    publisher.publish({ kind: 'text.delta', offset, payload: { text } })
    offset += text.length
  }
  await publisher.close()
  assert.equal(http.length, 0)
  assert.equal(socket.length, [...source].length)
  assert.equal(socket.map(value => (value as { payload: { text: string } }).payload.text).join(''), source)
})

test('relay uses immediate HTTP before subscription and after a socket failure', async () => {
  let status: ((value: string) => void) | undefined
  const delivered: unknown[] = []
  const channel = {
    subscribe: (callback: (value: string) => void) => { status = callback; return channel },
    send: async () => 'error',
    httpSend: async (_event: string, payload: unknown) => { delivered.push(payload) },
  }
  const client = { channel: () => channel, removeChannel: async () => undefined }
  const publisher = new LiveJobPublisher(client as never, JOB_ID, CHANNEL_HASH_INPUT)
  publisher.start()
  publisher.publish({ kind: 'text.delta', offset: 0, payload: { text: 'a' } })
  status?.('SUBSCRIBED')
  publisher.publish({ kind: 'text.delta', offset: 1, payload: { text: 'b' } })
  await publisher.close()
  assert.equal(delivered.length, 2)
})


test('a ready socket releases queued deltas without waiting for older HTTP requests', async () => {
  let status: ((value: string) => void) | undefined
  let release!: () => void
  const blockedHttp = new Promise<void>(resolve => { release = resolve })
  const socket: unknown[] = []
  const channel = {
    subscribe: (callback: (value: string) => void) => { status = callback; return channel },
    httpSend: async () => blockedHttp,
    send: async (value: { payload: unknown }) => { socket.push(value.payload); return 'ok' },
  }
  const client = { channel: () => channel, removeChannel: async () => undefined }
  const publisher = new LiveJobPublisher(client as never, JOB_ID, CHANNEL_HASH_INPUT)
  publisher.start()
  for (let offset = 0; offset < 10; offset++) {
    publisher.publish({ kind: 'text.delta', offset, payload: { text: 'a' } })
  }
  assert.equal(socket.length, 0)
  status?.('SUBSCRIBED')
  assert.equal(socket.length, 2, 'Subscription must release the pending queue immediately')
  publisher.publish({ kind: 'text.delta', offset: 10, payload: { text: 'b' } })
  assert.equal(socket.length, 3, 'New text must not wait behind the eight HTTP requests')
  release()
  await publisher.close()
})
