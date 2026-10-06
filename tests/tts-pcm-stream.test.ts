import assert from 'node:assert/strict'
import test from 'node:test'
import { preparePCMStream, speechSegments, SARAH_VOICE_ID } from '../lib/api/tts-pcm-stream'
const options = { apiKey: 'server-only-fixture-key', signal: new AbortController().signal }
const pcm = (...bytes: number[]) => new Response(new Uint8Array(bytes), { headers: { 'content-type': 'audio/pcm' } })

test('short first segment preserves all text, including surrogate pairs', () => {
  const text = '先完成最重要的事情。' + '☀️🪐你好'.repeat(500)
  const segments = speechSegments(text)
  assert.equal(segments.join(''), text)
  assert.ok(Array.from(segments[0]).length <= 96)
  assert.ok(segments.every(segment => Array.from(segment).length <= 800))
  assert.deepEqual(speechSegments('  你好  '), ['你好'])
})

test('PCM is available while the provider still has ungenerated audio', async () => {
  let finish!: () => void
  const waiting = new Promise<void>(resolve => { finish = resolve })
  let url = '', init: RequestInit | undefined
  const stream = await preparePCMStream({ ...options, text: '你好', fetcher: async (input, request) => {
    url = String(input); init = request
    return new Response(new ReadableStream({ async start(c) { c.enqueue(new Uint8Array([1, 0])); await waiting; c.enqueue(new Uint8Array([2, 0])); c.close() } }), { headers: { 'content-type': 'audio/pcm' } })
  } })
  assert.ok(url.includes(SARAH_VOICE_ID + '/stream?output_format=pcm_24000'))
  const body = JSON.parse(String(init?.body))
  assert.equal(body.model_id, 'eleven_flash_v2_5')
  assert.equal(body.language_code, 'zh')
  assert.equal(new Headers(init?.headers).get('xi-api-key'), options.apiKey)
  const reader = stream.getReader()
  assert.deepEqual((await reader.read()).value, new Uint8Array([1, 0]))
  finish()
  assert.deepEqual((await reader.read()).value, new Uint8Array([2, 0]))
  assert.equal((await reader.read()).done, true)
})

test('prefetching subsequent text does not reorder or omit speech', async () => {
  let index = 0
  const received: string[] = []
  const stream = await preparePCMStream({ ...options, text: 'x'.repeat(1700), fetcher: async (_, init) => {
    received.push(JSON.parse(String(init?.body)).text)
    return pcm(++index, 0)
  } })
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer())
  assert.equal(received.join(''), 'x'.repeat(1700))
  assert.deepEqual(Array.from(bytes), [1, 0, 2, 0, 3, 0, 4, 0])
})

test('provider errors, empty bodies, and malformed audio fail before a PCM response', async () => {
  for (const response of [new Response('', { status: 429 }), new Response('', { status: 502 }), new Response('html', { headers: { 'content-type': 'text/html' } }), pcm()]) {
    await assert.rejects(preparePCMStream({ ...options, text: 'test', fetcher: async () => response }))
  }
  await assert.rejects(preparePCMStream({ ...options, text: ' ', fetcher: async () => pcm(1, 0) }))
})

test('first-audio deadline cancels a provider that has not returned its body', async () => {
  let aborted = false
  await assert.rejects(preparePCMStream({ ...options, text: 'test', firstAudioTimeoutMs: 20, fetcher: async (_, init) => {
    return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('timed out')) }))
  } }))
  assert.equal(aborted, true)
})

test('cancel stops the current stream and any prefetched request', async () => {
  let aborted = 0
  const stream = await preparePCMStream({ ...options, text: 'x'.repeat(300), fetcher: async (_, init) => {
    init?.signal?.addEventListener('abort', () => { aborted++ })
    return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 0])) } }), { headers: { 'content-type': 'audio/pcm' } })
  } })
  const reader = stream.getReader(); await reader.read(); await reader.cancel()
  assert.equal(aborted, 2)
})

test('later provider failures propagate to the client rather than hanging the player', async () => {
  let call = 0
  const stream = await preparePCMStream({ ...options, text: 'x'.repeat(300), fetcher: async () => ++call === 1 ? pcm(1, 0) : new Response('', { status: 502 }) })
  const reader = stream.getReader(); await reader.read()
  await assert.rejects(reader.read())
})
