import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { acceptedLiveChatResponse } from '../lib/chat/live-response'
import type { readOwnedJob } from '../lib/jobs/read-model'
import type { JobEventStreamAdmission } from '../lib/jobs/stream-admission'

type OwnedJob = Awaited<ReturnType<typeof readOwnedJob>>
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const encoder = new TextEncoder()
const owned: OwnedJob = { ok: true, value: {} as never }
const denied: OwnedJob = { ok: false, kind: 'not_found' }

function fixture(options: { createThrows?: boolean; releaseThrows?: boolean } = {}) {
  const ownership = deferred<OwnedJob>(), admission = deferred<JobEventStreamAdmission>()
  const abort = new AbortController()
  let readsStarted = 0, leasesStarted = 0, streams = 0, releases = 0
  const signals: AbortSignal[] = []
  const jobId = randomUUID()
  const response = acceptedLiveChatResponse({
    request: new Request('http://localhost/api/chat', { method: 'POST', signal: abort.signal }),
    client: {} as never, principalId: randomUUID(), address: '127.0.0.1',
    accepted: { jobId, status: 'queued', created: true, streamUrl: `/api/v1/jobs/${jobId}/live?from_seq=0` },
  }, {
    readJob: async (_client, _principal, _job, signal) => {
      readsStarted += 1
      if (signal) signals.push(signal)
      return ownership.promise
    },
    acquireStream: async input => {
      leasesStarted += 1
      if (input.signal) signals.push(input.signal)
      return admission.promise
    },
    createStream: streamOptions => {
      streams += 1
      if (streamOptions.requestSignal.aborted) throw new Error('aborted stream must not start')
      if (options.createThrows) throw new Error('stream construction failed')
      return new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(encoder.encode('data: authorized\n\n')) },
        cancel() { return Promise.resolve(streamOptions.onClosed?.()) },
      })
    },
  })
  const lease: Extract<JobEventStreamAdmission, { acquired: true }> = {
    acquired: true,
    lease: { id: randomUUID(), hardExpiresAt: '2026-10-09T12:00:00Z', maxDurationMs: 60_000,
      renew: async () => true, release: async () => {
        releases += 1
        if (options.releaseThrows) throw new Error('release transport failed')
      } },
  }
  const reader = response.body!.getReader()
  return { ownership, admission, abort, lease, reader,
    counts: () => ({ readsStarted, leasesStarted, streams, releases }),
    signals }
}

async function accepted(f: ReturnType<typeof fixture>) {
  assert.equal(new TextDecoder().decode((await f.reader.read()).value), ': accepted\n\n')
  assert.deepEqual(f.counts(), { readsStarted: 1, leasesStarted: 1, streams: 0, releases: 0 },
    'Both existing guards start together, with no extra request or serial wait')
}
async function closedWithoutText(f: ReturnType<typeof fixture>, releases: number) {
  assert.equal((await f.reader.read()).done, true, 'Only the accepted comment may precede failed guards')
  await tick()
  assert.equal(f.counts().streams, 0)
  assert.equal(f.counts().releases, releases)
}

for (const failure of ['throw', 'false'] as const) {
  for (const leaseOrder of ['before', 'after'] as const) {
    test(`ownership ${failure}, lease ${leaseOrder}: release once and emit no protected text`, async () => {
      const f = fixture()
      await accepted(f)
      if (leaseOrder === 'before') { f.admission.resolve(f.lease); await tick() }
      if (failure === 'throw') f.ownership.reject(new Error('read dependency failed'))
      else f.ownership.resolve(denied)
      await tick()
      assert.equal(f.counts().streams, 0)
      if (leaseOrder === 'after') f.admission.resolve(f.lease)
      await closedWithoutText(f, 1)
    })
  }
}

for (const failure of ['reject', 'deny'] as const) {
  test(`lease ${failure}: no stream and no release without a lease`, async () => {
    const f = fixture()
    await accepted(f)
    if (failure === 'reject') f.admission.reject(new Error('lease unavailable'))
    else f.admission.resolve({ acquired: false, kind: 'capacity', retryAfterSeconds: 5 })
    f.ownership.resolve(owned)
    await closedWithoutText(f, 0)
  })
}

test('both parallel dependencies rejecting still close without output or release', async () => {
  const f = fixture()
  await accepted(f)
  f.ownership.reject(new Error('read unavailable'))
  f.admission.reject(new Error('lease unavailable'))
  await closedWithoutText(f, 0)
})

for (const guard of ['ownership', 'lease'] as const) {
  test(`request abort during ${guard}: preserve cancellation and release a late lease once`, async () => {
    const f = fixture()
    await accepted(f)
    if (guard === 'ownership') f.admission.resolve(f.lease)
    else f.ownership.resolve(owned)
    f.abort.abort()
    assert.ok(f.signals.every(signal => signal.aborted))
    if (guard === 'ownership') f.ownership.reject(new DOMException('aborted', 'AbortError'))
    else f.admission.resolve(f.lease)
    await closedWithoutText(f, 1)
  })
}

test('reader cancel during setup releases a subsequently acquired lease without a stream', async () => {
  const f = fixture()
  await accepted(f)
  await f.reader.cancel()
  assert.ok(f.signals.every(signal => signal.aborted))
  f.ownership.resolve(owned)
  f.admission.resolve(f.lease)
  await closedWithoutText(f, 1)
})

test('createStream throwing releases the acquired lease once without text', async () => {
  const f = fixture({ createThrows: true })
  await accepted(f)
  f.ownership.resolve(owned)
  f.admission.resolve(f.lease)
  assert.equal((await f.reader.read()).done, true)
  assert.equal(f.counts().streams, 1)
  assert.equal(f.counts().releases, 1)
})

test('release failure does not retry or permit a stream after denied ownership', async () => {
  const f = fixture({ releaseThrows: true })
  await accepted(f)
  f.ownership.resolve(denied)
  f.admission.resolve(f.lease)
  await closedWithoutText(f, 1)
})

test('success forwards first text as soon as both parallel guards finish and releases on cancel', async () => {
  const f = fixture()
  await accepted(f)
  f.admission.resolve(f.lease)
  await tick()
  assert.equal(f.counts().streams, 0)
  f.ownership.resolve(owned)
  assert.equal(new TextDecoder().decode((await f.reader.read()).value), 'data: authorized\n\n')
  assert.equal(f.counts().releases, 0)
  await f.reader.cancel()
  await tick()
  assert.equal(f.counts().streams, 1)
  assert.equal(f.counts().releases, 1)
})
