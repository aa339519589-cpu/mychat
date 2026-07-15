import assert from 'node:assert/strict'
import test from 'node:test'
import {
  awaitAbortableRequest,
  type AbortableRequest,
} from '../lib/jobs/abortable-request'

function pendingRequest(observed: { signal?: AbortSignal }): AbortableRequest<never> {
  return {
    then: () => new Promise<never>(() => undefined),
    abortSignal(signal: AbortSignal) {
      observed.signal = signal
      return new Promise<never>(() => undefined)
    },
  }
}

test('abortable requests cancel the underlying operation on timeout', async () => {
  const observed: { signal?: AbortSignal } = {}
  await assert.rejects(awaitAbortableRequest(pendingRequest(observed), {
    timeoutMs: 10,
    timeoutMessage: 'database request timed out',
  }), /database request timed out/)
  assert.equal(observed.signal?.aborted, true)
})

test('abortable requests forward caller cancellation to the underlying operation', async () => {
  const observed: { signal?: AbortSignal } = {}
  const controller = new AbortController()
  const operation = awaitAbortableRequest(pendingRequest(observed), {
    timeoutMs: 10_000,
    timeoutMessage: 'must not time out',
    signal: controller.signal,
  })
  controller.abort(new Error('caller disconnected'))
  await assert.rejects(operation, /caller disconnected/)
  assert.equal(observed.signal?.aborted, true)
})

test('abortable requests preserve successful responses', async () => {
  const value = await awaitAbortableRequest(Promise.resolve({ ok: true }), {
    timeoutMs: 100,
    timeoutMessage: 'must not time out',
  })
  assert.deepEqual(value, { ok: true })
})
