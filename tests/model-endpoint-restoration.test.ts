import assert from 'node:assert/strict'
import test from 'node:test'
import { restoreModelEndpointsWhenAvailable } from '../components/literary-chat/model-endpoint-restoration'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(next => { resolve = next })
  return { promise, resolve }
}

test('restores model selection when endpoints return without waiting for unrelated bootstrap work', async () => {
  const endpoints = deferred<never[]>()
  let restored = false
  restoreModelEndpointsWhenAvailable({
    fetchEndpoints: () => endpoints.promise,
    restore: () => { restored = true },
    isCancelled: () => false,
  })

  endpoints.resolve([])
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(restored, true)
})

test('does not restore a cancelled bootstrap session', async () => {
  const endpoints = deferred<never[]>()
  let cancelled = false
  let restored = false
  restoreModelEndpointsWhenAvailable({
    fetchEndpoints: () => endpoints.promise,
    restore: () => { restored = true },
    isCancelled: () => cancelled,
  })

  cancelled = true
  endpoints.resolve([])
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(restored, false)
})
