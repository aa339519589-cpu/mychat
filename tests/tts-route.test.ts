import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'
import { createTTSHandler } from '../app/api/tts/route'
import type { AuthCtx } from '../lib/api/guard'

const authenticated: AuthCtx = {
  supabase: null,
  userId: 'test-user',
  isAnonymous: false,
}

function makeRequest(body: string): NextRequest {
  return new NextRequest('https://mychat.test/api/tts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
}

function makeHandler(overrides: Parameters<typeof createTTSHandler>[0] = {}) {
  return createTTSHandler({
    resolveAuth: async () => authenticated,
    enforceRequestRateLimit: async () => ({}),
    getApiKey: () => 'test-provider-key',
    fetch: async () => new Response('unexpected provider call', { status: 500 }),
    ...overrides,
  })
}

async function errorCode(response: Response): Promise<string | undefined> {
  const body = await response.json() as { error?: { code?: string } }
  return body.error?.code
}

test('TTS route rejects unauthenticated requests before parsing or contacting the provider', async () => {
  let providerCalls = 0
  const handler = makeHandler({
    resolveAuth: async () => ({ ...authenticated, userId: null, isAnonymous: true }),
    fetch: async () => {
      providerCalls++
      return new Response(new Uint8Array([1]), { headers: { 'content-type': 'audio/mpeg' } })
    },
  })

  const response = await handler(makeRequest('not-json'))

  assert.equal(response.status, 401)
  assert.equal(await errorCode(response), 'AUTH_REQUIRED')
  assert.equal(providerCalls, 0)
})

test('TTS route fails closed when authentication is unavailable', async () => {
  let rateLimitCalls = 0
  const handler = makeHandler({
    resolveAuth: async () => ({ ...authenticated, userId: null, authUnavailable: true }),
    enforceRequestRateLimit: async () => {
      rateLimitCalls++
      return {}
    },
  })

  const response = await handler(makeRequest('{'))

  assert.equal(response.status, 503)
  assert.equal(await errorCode(response), 'AUTH_DEPENDENCY_UNAVAILABLE')
  assert.equal(rateLimitCalls, 0)
})

test('TTS route returns the rate-limit response without invoking synthesis', async () => {
  const limited = Response.json({ error: 'limited' }, { status: 429 })
  let providerCalls = 0
  const handler = makeHandler({
    enforceRequestRateLimit: async () => ({ response: limited }),
    fetch: async () => {
      providerCalls++
      return new Response(new Uint8Array([1]), { headers: { 'content-type': 'audio/mpeg' } })
    },
  })

  const response = await handler(makeRequest('not-json'))

  assert.equal(response, limited)
  assert.equal(providerCalls, 0)
})

test('TTS route sends authenticated synthesis and streams bounded MP3 audio', async () => {
  const audio = new Uint8Array([0x49, 0x44, 0x33, 0x01])
  let providerUrl = ''
  let providerInit: RequestInit | undefined
  const handler = makeHandler({
    fetch: async (input, init) => {
      providerUrl = String(input)
      providerInit = init
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(audio)
          controller.close()
        },
      }), {
        headers: { 'content-type': 'audio/mpeg', 'content-length': String(audio.byteLength) },
      })
    },
  })

  const response = await handler(makeRequest(JSON.stringify({ text: '你好，MyChat。' })))

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'audio/mpeg')
  assert.equal(response.headers.get('cache-control'), 'no-store, no-transform')
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), audio)
  assert.equal(providerUrl, 'https://api.fish.audio/v1/tts')
  assert.equal(providerInit?.method, 'POST')
  assert.equal(new Headers(providerInit?.headers).get('authorization'), 'Bearer test-provider-key')
  assert.equal(new Headers(providerInit?.headers).get('accept'), 'audio/mpeg')
  assert.equal(new Headers(providerInit?.headers).get('model'), 's2.1-pro-free')
  assert.equal(providerInit?.cache, 'no-store')
  assert.deepEqual(JSON.parse(String(providerInit?.body)), {
    text: '你好，MyChat。',
    reference_id: '652f3d49b41e4e4b8ce3ca8ee2380bd5',
    format: 'mp3',
    chunk_length: 100,
    latency: 'balanced',
  })
})

test('TTS route does not expose provider error bodies or credentials', async () => {
  const handler = makeHandler({
    fetch: async () => new Response('test-provider-key internal failure detail', { status: 503 }),
  })

  const response = await handler(makeRequest(JSON.stringify({ text: '请读这句话' })))
  const body = await response.text()

  assert.equal(response.status, 502)
  assert.equal(await errorCode(new Response(body, { headers: { 'content-type': 'application/json' } })), 'DEPENDENCY_UNAVAILABLE')
  assert.equal(body.includes('test-provider-key'), false)
  assert.equal(body.includes('internal failure detail'), false)
})

test('TTS route refuses to call the provider when its credential is missing', async () => {
  let providerCalls = 0
  const handler = makeHandler({
    getApiKey: () => undefined,
    fetch: async () => {
      providerCalls++
      return new Response(new Uint8Array([1]), { headers: { 'content-type': 'audio/mpeg' } })
    },
  })

  const response = await handler(makeRequest(JSON.stringify({ text: '请读这句话' })))

  assert.equal(response.status, 503)
  assert.equal(await errorCode(response), 'DEPENDENCY_UNAVAILABLE')
  assert.equal(providerCalls, 0)
})

test('TTS route rejects empty text before contacting the provider', async () => {
  let providerCalls = 0
  const handler = makeHandler({
    fetch: async () => {
      providerCalls++
      return new Response(new Uint8Array([1]), { headers: { 'content-type': 'audio/mpeg' } })
    },
  })

  const response = await handler(makeRequest(JSON.stringify({ text: '   ' })))

  assert.equal(response.status, 400)
  assert.equal(await errorCode(response), 'INVALID_REQUEST')
  assert.equal(providerCalls, 0)
})

test('PCM route uses the Sarah server credential and returns the first playable bytes', async () => {
  let providerBody: Record<string, unknown> = {}
  const handler = makeHandler({
    getPCMApiKey: () => 'private-elevenlabs-fixture',
    fetch: async (url, init) => {
      assert.ok(String(url).includes('EXAVITQu4vr4xnSDxMaL/stream?output_format=pcm_24000'))
      assert.equal(new Headers(init?.headers).get('xi-api-key'), 'private-elevenlabs-fixture')
      providerBody = JSON.parse(String(init?.body))
      return new Response(new Uint8Array([1, 0, 2, 0]), { headers: { 'content-type': 'audio/pcm' } })
    },
  })
  const result = await handler(makeRequest(JSON.stringify({ text: '你好，MyChat', format: 'pcm', apiKey: 'ignored-client-key' })))
  assert.equal(result.status, 200)
  assert.equal(result.headers.get('content-type'), 'audio/pcm')
  assert.equal(result.headers.get('x-audio-sample-rate'), '24000')
  assert.equal(result.headers.get('x-tts-voice-id'), 'EXAVITQu4vr4xnSDxMaL')
  assert.equal(providerBody.text, '你好，MyChat')
  assert.deepEqual(new Uint8Array(await result.arrayBuffer()), new Uint8Array([1, 0, 2, 0]))
})

test('PCM provider failures return a recoverable error and never expose the credential', async () => {
  const handler = makeHandler({ getPCMApiKey: () => 'private-elevenlabs-fixture', fetch: async () => new Response('sensitive provider error', { status: 429 }) })
  const result = await handler(makeRequest(JSON.stringify({ text: '你好', format: 'pcm' })))
  assert.equal(result.status, 502)
  const body = await result.text()
  assert.ok(!body.includes('private-elevenlabs-fixture'))
  assert.ok(!body.includes('sensitive provider error'))
})

test('unknown audio formats do not allocate a provider stream', async () => {
  const result = await makeHandler()(makeRequest(JSON.stringify({ text: '你好', format: 'html' })))
  assert.equal(result.status, 400)
})
