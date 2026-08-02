import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createJobEventStream } from '../lib/jobs/event-stream'
import type { JsonObject } from '../lib/jobs/contracts'

const client = {} as SupabaseClient
const principalId = '95000000-0000-4000-8000-000000000001'
const jobId = '95000000-0000-4000-8000-000000000002'

function event(seq: number, kind = 'job.progress', payload: JsonObject = {}) {
  return {
    id: `95000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    jobId,
    seq,
    kind,
    schemaVersion: 1,
    payload,
    createdAt: new Date().toISOString(),
  }
}

test('event stream preserves cursor order, observes terminal state, and releases admission', async () => {
  let reads = 0
  let releases = 0
  const stream = createJobEventStream({
    client,
    principalId,
    jobId,
    fromSequence: 0,
    initialStatus: 'running',
    requestSignal: new AbortController().signal,
    onClosed: async () => { releases += 1 },
  }, {
    readEvents: async () => ({
      ok: true,
      value: reads++ === 0
        ? [event(1), event(2, 'job.terminal', { status: 'completed' })]
        : [],
    }),
  })
  const body = await new Response(stream).text()
  assert.match(body, /id: 1\nevent: job\.progress/)
  assert.match(body, /id: 2\nevent: job\.terminal/)
  assert.equal((body.match(/event: job\./g) ?? []).length, 2)
  assert.equal(releases, 1)
})

test('event stream disconnects a slow consumer instead of buffering an event batch', async () => {
  const stream = createJobEventStream({
    client,
    principalId,
    jobId,
    fromSequence: 0,
    initialStatus: 'running',
    requestSignal: new AbortController().signal,
  }, {
    readEvents: async () => ({ ok: true, value: [event(1), event(2)] }),
    backpressureTimeoutMs: 8,
    backpressurePollMs: 1,
  })
  await new Promise(resolve => setTimeout(resolve, 20))
  const body = await new Response(stream).text()
  assert.match(body, /id: 1/)
  assert.doesNotMatch(body, /id: 2/)
})

test('event stream has a hard duration even if a job never becomes terminal', async () => {
  let reads = 0
  const stream = createJobEventStream({
    client,
    principalId,
    jobId,
    fromSequence: 0,
    initialStatus: 'running',
    requestSignal: new AbortController().signal,
    maxDurationMs: 10,
  }, {
    readEvents: async () => {
      reads += 1
      return { ok: true, value: [] }
    },
  })
  assert.equal(await new Response(stream).text(), '')
  assert.equal(reads, 1)
})

test('consumer cancellation releases admission exactly once even while stream startup is active', async () => {
  let releases = 0
  const request = new AbortController()
  const stream = createJobEventStream({
    client,
    principalId,
    jobId,
    fromSequence: 0,
    initialStatus: 'running',
    requestSignal: request.signal,
    onClosed: async () => { releases += 1 },
  }, {
    readEvents: async () => ({ ok: true, value: [] }),
  })
  await stream.cancel('client_closed')
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(releases, 1)
})

test('active event polling never backs off into multi-second Chat gaps', async () => {
  let reads = 0
  const waits: number[] = []
  const stream = createJobEventStream({
    client,
    principalId,
    jobId,
    jobType: 'chat.generation',
    fromSequence: 0,
    initialStatus: 'running',
    requestSignal: new AbortController().signal,
  }, {
    readEvents: async () => {
      reads += 1
      if (reads <= 5) return { ok: true, value: [] }
      if (reads === 6) return {
        ok: true,
        value: [event(1, 'text.delta', { text: '首个字符' })],
      }
      return {
        ok: true,
        value: [event(2, 'job.terminal', { status: 'completed' })],
      }
    },
    wait: async milliseconds => { waits.push(milliseconds) },
  })

  const body = await new Response(stream).text()
  assert.match(body, /首个字符/)
  assert.ok(waits.length >= 5)
  assert.ok(Math.max(...waits) <= 120)
  assert.deepEqual(waits.slice(0, 5), [80, 120, 120, 120, 120])
})

test('non-Chat jobs retain their existing exponential polling policy', async () => {
  let reads = 0
  const waits: number[] = []
  const stream = createJobEventStream({
    client,
    principalId,
    jobId,
    jobType: 'agent.task',
    fromSequence: 0,
    initialStatus: 'running',
    requestSignal: new AbortController().signal,
  }, {
    readEvents: async () => {
      reads += 1
      if (reads <= 4) return { ok: true, value: [] }
      return {
        ok: true,
        value: [event(1, 'job.terminal', { status: 'completed' })],
      }
    },
    wait: async milliseconds => { waits.push(milliseconds) },
  })

  await new Response(stream).text()
  assert.deepEqual(waits.slice(0, 4), [500, 1_000, 2_000, 2_000])
})
