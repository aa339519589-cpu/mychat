import assert from 'node:assert/strict'
import test from 'node:test'
import { JobEventWriter } from '../lib/jobs/event-writer'
import type { JobEventDraft, JsonObject } from '../lib/jobs/contracts'
import type { JobExecutionContext } from '../lib/jobs/worker'

function context(options: { rejectAppend?: boolean; progress?: JsonObject } = {}) {
  const batches: JobEventDraft[][] = []
  const checkpoints: Array<{ phase: string; checkpoint: JsonObject; progress?: JsonObject }> = []
  const value = {
    job: {
      id: 'job',
      checkpoint: options.progress ? { progress: options.progress } : null,
    },
    fence: { jobId: 'job', workerId: 'worker', leaseVersion: 1 },
    signal: new AbortController().signal,
    assertAuthority() {},
    async appendEvents(events: readonly JobEventDraft[]) {
      if (options.rejectAppend) throw new Error('stale fence')
      batches.push([...events])
    },
    async checkpoint(input: { phase: string; checkpoint: JsonObject; progress?: JsonObject }) {
      checkpoints.push(input)
    },
  } as unknown as JobExecutionContext
  return { value, batches, checkpoints }
}

test('job event writer coalesces deltas and checkpoints the materialized snapshot', async () => {
  const target = context()
  const writer = new JobEventWriter(target.value)
  writer.emit({ text: 'hello' })
  writer.emit({ text: ' world' })
  writer.emit({ thinking: 'reason' })
  await writer.checkpoint({
    phase: 'model_round_1',
    data: { round: 1 },
    resumable: true,
    extraProgress: { tokens: 7 },
  })
  assert.equal(target.batches.length, 1)
  assert.deepEqual(target.batches[0].map(event => event.payload), [
    { text: 'hello world' },
    { thinking: 'reason' },
  ])
  assert.equal(target.checkpoints[0]?.phase, 'model_round_1')
  assert.deepEqual(target.checkpoints[0]?.progress, {
    content: 'hello world',
    thinking: 'reason',
    contentParts: [{ type: 'text', text: 'hello world' }],
    thinkingParts: [{ type: 'text', text: 'reason' }],
    tokens: 7,
  })
})

test('job event writer propagates a durable append failure before finalize', async () => {
  const writer = new JobEventWriter(context({ rejectAppend: true }).value)
  writer.emit({ text: 'must persist' })
  await assert.rejects(writer.drain(), /stale fence/)
})

test('job event writer hydrates the materialized checkpoint prefix without emitting it twice', async () => {
  const target = context({
    progress: {
      content: 'durable prefix',
      thinkingParts: [{ type: 'text', text: 'prior reasoning' }],
    },
  })
  const writer = new JobEventWriter(target.value)
  writer.emit({ text: ' plus resumed output' })
  writer.emit({ thinking: ' and new reasoning' })
  await writer.drain()

  assert.equal(writer.text(), 'durable prefix plus resumed output')
  assert.equal(writer.thinking(), 'prior reasoning and new reasoning')
  assert.deepEqual(target.batches.flatMap(batch => batch.map(event => event.payload)), [
    { text: ' plus resumed output' },
    { thinking: ' and new reasoning' },
  ])
})


test('durable drain does not wait for best-effort live relay cleanup', async () => {
  const target = context()
  const writer = new JobEventWriter(target.value, () => undefined)
  let closeStarted = false
  let finishClose!: () => void
  const cleanup = new Promise<void>(resolve => { finishClose = resolve })
  Object.defineProperty(writer, 'livePublisher', {
    value: { close: () => { closeStarted = true; return cleanup } },
  })
  writer.emit({ text: 'durable reply' })
  const deadline = setTimeout(() => finishClose(), 1_000)
  try {
    await writer.drain()
    assert.equal(closeStarted, true)
    assert.equal(target.batches.flat()[0]?.payload.text, 'durable reply')
    let cleanupFinished = false
    void cleanup.then(() => { cleanupFinished = true })
    await Promise.resolve()
    assert.equal(cleanupFinished, false, 'preview cleanup must not block durable completion')
  } finally {
    clearTimeout(deadline)
    finishClose()
  }
})

test('model output completion is relayed immediately as a live control event', async () => {
  const target = context()
  const live: Array<{ kind: string; payload: JsonObject }> = []
  const writer = new JobEventWriter(target.value, event => {
    live.push({ kind: event.kind, payload: event.payload })
  })

  await writer.append('model.output_completed', {
    phase: 'provider_complete',
    contentLength: 6,
    thinkingLength: 0,
  })

  assert.equal(live[0]?.kind, 'model.output_completed')
  assert.equal(live[0]?.payload.phase, 'provider_complete')
  assert.ok(target.batches.flat().some(event => event.kind === 'model.output_completed'))
})


test('slow durable writes coalesce waiting deltas instead of building a per-timer RPC backlog', async () => {
  const target = context()
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  let calls = 0
  target.value.appendEvents = async events => {
    calls++
    if (calls === 1) await blocked
    target.batches.push([...events])
  }
  const live: Array<{ kind: string; payload: JsonObject }> = []
  const writer = new JobEventWriter(target.value, event => { live.push(event) })
  await writer.append('job.started', { phase: 'preparing' })
  try {
    for (let index = 0; index < 20; index++) {
      writer.emit({ text: '中文' })
      await new Promise(resolve => setTimeout(resolve, 16))
    }
    assert.equal(live.filter(event => event.kind === 'text.delta').length, 20,
      'Live streaming must stay immediate while persistence is blocked')
    const completed = writer.append('model.output_completed', { contentLength: 40 })
    assert.equal(live.at(-1)?.kind, 'model.output_completed')
    release()
    await completed
    await writer.drain()
    assert.ok(target.batches.length <= 3, 'Timer ticks must not each reserve another database RPC')
    assert.equal(target.batches.flat().filter(event => event.kind === 'text.delta')
      .map(event => event.payload.text).join(''), '中文'.repeat(20))
    assert.equal(target.batches.flat().at(-1)?.kind, 'model.output_completed')
  } finally { release() }
})
