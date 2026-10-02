import assert from 'node:assert/strict'
import test from 'node:test'
import { prepareBoundedAudioStream } from '../lib/api/tts-audio-stream'

test('audio stream exposes its first chunk before upstream completion', async () => {
  let releaseSecondChunk: (() => void) | undefined
  const secondChunkAvailable = new Promise<void>(resolve => { releaseSecondChunk = resolve })
  const upstream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(new Uint8Array([1, 2]))
      await secondChunkAvailable
      controller.enqueue(new Uint8Array([3, 4]))
      controller.close()
    },
  })

  const stream = await prepareBoundedAudioStream(upstream, 4)
  const reader = stream.getReader()
  assert.deepEqual(await reader.read(), { done: false, value: new Uint8Array([1, 2]) })

  releaseSecondChunk?.()
  assert.deepEqual(await reader.read(), { done: false, value: new Uint8Array([3, 4]) })
  assert.deepEqual(await reader.read(), { done: true, value: undefined })
})

test('audio stream rejects empty first chunks and enforces the cumulative byte limit', async () => {
  await assert.rejects(
    prepareBoundedAudioStream(new ReadableStream<Uint8Array>({ start(c) { c.close() } }), 8),
    /空音频/,
  )

  const stream = await prepareBoundedAudioStream(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]))
      controller.enqueue(new Uint8Array([3, 4]))
      controller.close()
    },
  }), 3)
  const reader = stream.getReader()
  assert.deepEqual(await reader.read(), { done: false, value: new Uint8Array([1, 2]) })
  await assert.rejects(reader.read(), /过大/)
})

test('canceling the downstream stream cancels upstream audio generation', async () => {
  let canceled = false
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array([1])) },
    cancel() { canceled = true },
  })
  const stream = await prepareBoundedAudioStream(upstream, 8)
  const reader = stream.getReader()
  await reader.read()
  await reader.cancel()
  assert.equal(canceled, true)
})
