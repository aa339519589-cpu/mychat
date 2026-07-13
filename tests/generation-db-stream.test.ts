import assert from 'node:assert/strict'
import test from 'node:test'
import { createDatabaseGenerationStream } from '../lib/generation/db-stream'
import type { GenerationDatabaseRow } from '../lib/generation/types'

function row(
  status: GenerationDatabaseRow['status'],
  sequence: number,
  content = '',
): GenerationDatabaseRow {
  return {
    id: '10000000-0000-4000-8000-000000000010',
    user_id: 'user-1',
    conversation_id: '20000000-0000-4000-8000-000000000010',
    assistant_message_id: '30000000-0000-4000-8000-000000000010',
    status,
    content,
    thinking: '',
    sequence,
    error: null,
    media: [],
  }
}

function events(raw: string): Array<Record<string, unknown>> {
  return raw.trim().split('\n\n').map(frame => JSON.parse(frame.replace(/^data: /, '')))
}

test('a database running snapshot stays open and polls until the real terminal state', async () => {
  let polls = 0
  const stream = createDatabaseGenerationStream(
    row('running', 1, 'a'),
    async () => {
      polls += 1
      if (polls === 1) return { kind: 'found' as const, value: row('running', 2, 'ab') }
      return { kind: 'found' as const, value: row('completed', 3, 'abc') }
    },
    1,
    { pollIntervalMs: 10, heartbeatIntervalMs: 1_000 },
  )

  const received = events(await new Response(stream).text())
  assert.equal(received[0].status, 'running')
  assert.equal(received[0].type, 'status')
  assert.equal(received.some(event => event.status === 'running' && event.type === 'done'), false)
  assert.equal(received.at(-1)?.status, 'completed')
  assert.equal(received.at(-1)?.type, 'done')
  assert.equal(received.at(-1)?.content, 'abc')
  assert.ok(polls >= 2)
})

test('a transient missing database read does not finish a running stream', async () => {
  let polls = 0
  const stream = createDatabaseGenerationStream(
    row('running', 1),
    async () => {
      polls += 1
      return polls === 1
        ? { kind: 'not_found' as const }
        : { kind: 'found' as const, value: row('cancelled', 2, 'partial') }
    },
    0,
    { pollIntervalMs: 10, heartbeatIntervalMs: 1_000 },
  )

  const received = events(await new Response(stream).text())
  assert.deepEqual(received.map(event => event.status), ['running', 'cancelled'])
  assert.equal(received.at(-1)?.type, 'done')
})

test('a permanent database partition emits a recoverable bounded error and releases once', async () => {
  let polls = 0
  let releases = 0
  const stream = createDatabaseGenerationStream(
    row('running', 1, 'prefix'),
    async () => {
      polls += 1
      return { kind: 'unavailable' as const, reason: 'database_error' as const }
    },
    0,
    {
      pollIntervalMs: 10,
      heartbeatIntervalMs: 1_000,
      maxConsecutiveReadFailures: 2,
      onClose: () => { releases += 1 },
    },
  )

  const received = events(await new Response(stream).text())
  assert.equal(polls, 2)
  assert.equal(releases, 1)
  assert.equal(received.at(-1)?.type, 'error')
  assert.equal(received.at(-1)?.recoverable, true)
  assert.equal(received.at(-1)?.code, 'generation_coordination_unavailable')
  assert.equal(received.some(event => event.type === 'done'), false)
})

test('an initial terminal snapshot closes immediately and releases its permit once', async () => {
  let polls = 0
  let releases = 0
  const stream = createDatabaseGenerationStream(
    row('failed', 4, 'partial'),
    async () => {
      polls += 1
      return { kind: 'not_found' as const }
    },
    0,
    { onClose: () => { releases += 1 } },
  )

  const received = events(await new Response(stream).text())
  assert.equal(polls, 0)
  assert.equal(releases, 1)
  assert.equal(received.at(-1)?.status, 'failed')
  assert.equal(received.at(-1)?.type, 'done')
})

test('request abort closes polling and releases its permit exactly once', async () => {
  const request = new AbortController()
  let releases = 0
  const stream = createDatabaseGenerationStream(
    row('running', 1),
    async () => ({ kind: 'found' as const, value: row('running', 1) }),
    0,
    {
      signal: request.signal,
      pollIntervalMs: 1_000,
      onClose: () => { releases += 1 },
    },
  )
  const reader = stream.getReader()
  const first = await reader.read()
  assert.equal(first.done, false)
  request.abort()
  const closed = await reader.read()
  assert.equal(closed.done, true)
  await reader.cancel()
  assert.equal(releases, 1)
})

test('consumer cancellation releases its permit exactly once', async () => {
  let releases = 0
  const stream = createDatabaseGenerationStream(
    row('running', 1),
    async () => ({ kind: 'found' as const, value: row('running', 1) }),
    0,
    {
      pollIntervalMs: 1_000,
      onClose: () => { releases += 1 },
    },
  )
  const reader = stream.getReader()
  assert.equal((await reader.read()).done, false)
  await reader.cancel()
  await reader.cancel()
  assert.equal(releases, 1)
})
