import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@/lib/supabase/types'
import { createJobEventStream } from '@/lib/jobs/event-stream'
import type { PublicJobEvent, PublicJobSnapshot } from '@/lib/jobs/read-model'

const jobId = '97000000-0000-4000-8000-000000000001'
const principalId = '97000000-0000-4000-8000-000000000002'

function completedJob(content = 'hello from the completed job'): PublicJobSnapshot {
  return {
    id: jobId,
    type: 'chat.generation',
    queue: 'chat',
    subject: {},
    status: 'completed',
    attempt: 1,
    maxAttempts: 3,
    priority: 0,
    availableAt: '2026-07-29T15:00:00.000Z',
    cancelRequestedAt: null,
    progress: {},
    result: { content, thinking: '', schemaVersion: 1 },
    errorClass: null,
    errorCode: null,
    eventSequence: 4,
    createdAt: '2026-07-29T15:00:00.000Z',
    updatedAt: '2026-07-29T15:00:09.000Z',
    startedAt: '2026-07-29T15:00:01.000Z',
    terminalAt: '2026-07-29T15:00:09.000Z',
  }
}

async function streamText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let output = ''
  while (true) {
    const value = await reader.read()
    if (value.done) return output + decoder.decode()
    output += decoder.decode(value.value, { stream: true })
  }
}

function frameData(text: string): Record<string, unknown>[] {
  return text.split('\n\n').flatMap(frame => {
    const line = frame.split('\n').find(value => value.startsWith('data: '))
    return line ? [JSON.parse(line.slice(6)) as Record<string, unknown>] : []
  })
}

test('a completed job always emits one authoritative terminal event even when the event row is absent', async () => {
  let jobReads = 0
  let closed = 0
  const stream = createJobEventStream({
    client: {} as SupabaseClient,
    principalId,
    jobId,
    fromSequence: 4,
    initialStatus: 'completed',
    requestSignal: new AbortController().signal,
    onClosed: () => { closed += 1 },
  }, {
    readEvents: async () => ({ ok: true as const, value: [] }),
    readJob: async () => {
      jobReads += 1
      return { ok: true as const, value: completedJob() }
    },
    wait: async () => { throw new Error('terminal recovery must not wait') },
    now: () => 0,
  })

  const text = await streamText(stream)
  const events = frameData(text)
  assert.equal(jobReads, 1)
  assert.equal(closed, 1)
  assert.equal(events.length, 1)
  assert.equal(events[0]?.kind, 'job.terminal')
  assert.equal(events[0]?.seq, 5)
  assert.deepEqual(events[0]?.payload, {
    status: 'completed',
    result: { content: 'hello from the completed job', thinking: '', schemaVersion: 1 },
  })
})

test('an existing terminal event is forwarded once without a synthetic duplicate', async () => {
  const terminal: PublicJobEvent = {
    id: '97000000-0000-4000-8000-000000000003',
    jobId,
    seq: 5,
    kind: 'job.terminal',
    schemaVersion: 1,
    payload: {
      status: 'completed',
      result: { content: 'terminal row', thinking: '', schemaVersion: 1 },
    },
    createdAt: '2026-07-29T15:00:09.000Z',
  }
  let eventReads = 0
  const stream = createJobEventStream({
    client: {} as SupabaseClient,
    principalId,
    jobId,
    fromSequence: 4,
    initialStatus: 'leased',
    requestSignal: new AbortController().signal,
  }, {
    readEvents: async () => {
      eventReads += 1
      return { ok: true as const, value: eventReads === 1 ? [terminal] : [] }
    },
    readJob: async () => { throw new Error('a delivered terminal event must not be synthesized') },
    wait: async () => { throw new Error('terminal delivery must not wait') },
    now: () => 0,
  })

  const events = frameData(await streamText(stream))
  assert.equal(events.length, 1)
  assert.equal(events[0]?.kind, 'job.terminal')
  assert.equal(events[0]?.seq, 5)
  assert.deepEqual(events[0]?.payload, terminal.payload)
})
