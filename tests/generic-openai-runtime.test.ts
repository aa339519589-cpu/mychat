import test from 'node:test'
import assert from 'node:assert/strict'
import { chatCompletionsUrl } from '../lib/llm/openai'
import { normalizeOpenAIBaseUrl } from '../lib/llm/openai-compatible'
import { runTurn } from '../lib/llm/turn'
import { runAgentLoop } from '../lib/llm/agent-loop'

test('chat completion URLs preserve explicit OpenAI-compatible prefixes', () => {
  assert.equal(chatCompletionsUrl('https://api.example.com'), 'https://api.example.com/v1/chat/completions')
  assert.equal(chatCompletionsUrl('https://api.example.com/v1'), 'https://api.example.com/v1/chat/completions')
  assert.equal(chatCompletionsUrl('https://api.example.com/v1beta/openai'), 'https://api.example.com/v1beta/openai/chat/completions')
  assert.equal(chatCompletionsUrl('https://api.example.com/gateway/chat/completions'), 'https://api.example.com/gateway/chat/completions')

  const normalizedGateway = normalizeOpenAIBaseUrl('https://api.example.com/gateway/chat/completions')
  assert.equal(normalizedGateway, 'https://api.example.com/gateway')
  assert.equal(chatCompletionsUrl(normalizedGateway), 'https://api.example.com/gateway/chat/completions')
})

test('generic provider cancels oversized error responses without exposing their content', { concurrency: false }, async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  const upstreamSecret = 'upstream-sensitive-marker'
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`${upstreamSecret}${'x'.repeat(96 * 1024)}`))
    },
    cancel() { cancelled = true },
  })
  globalThis.fetch = async () => new Response(body, { status: 502 })

  await assert.rejects(
    runTurn('https://api.example.com/v1/chat/completions', 'test-key', 'test-model', [], [], () => {}, { adapter: 'generic-openai', fetcher: globalThis.fetch }),
    error => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /响应超过安全限制/)
      assert.doesNotMatch(error.message, new RegExp(upstreamSecret))
      return true
    },
  )
  assert.equal(cancelled, true)
})

test('generic provider cancels a stream whose accumulated model text is too large', { concurrency: false }, async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  let cancelled = false
  const event = `data: ${JSON.stringify({ choices: [{ delta: { content: 'x'.repeat(1024 * 1024 + 1) } }] })}\n\n`
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(event)) },
    cancel() { cancelled = true },
  })
  globalThis.fetch = async () => new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })

  await assert.rejects(
    runTurn('https://api.example.com/v1/chat/completions', 'test-key', 'test-model', [], [], () => {}, { adapter: 'generic-openai', fetcher: globalThis.fetch }),
    /响应超过安全限制/,
  )
  assert.equal(cancelled, true)
})

test('generic provider caps cumulative bytes even when a stream has no parseable events', { concurrency: false }, async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  let cancelled = false
  const chunk = new TextEncoder().encode('x'.repeat(512 * 1024))
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(chunk) },
    cancel() { cancelled = true },
  })
  globalThis.fetch = async () => new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })

  await assert.rejects(
    runTurn('https://api.example.com/v1/chat/completions', 'test-key', 'test-model', [], [], () => {}, { adapter: 'generic-openai', fetcher: globalThis.fetch }),
    /响应超过安全限制/,
  )
  assert.equal(cancelled, true)
})

test('caller completion cap is sent upstream and stops excess streamed text locally', async () => {
  let cancelled = false
  const requestBodies: Record<string, unknown>[] = []
  const event = `data: ${JSON.stringify({ choices: [{ delta: { content: 'x'.repeat(200) } }] })}\n\n`
  const fetcher: typeof fetch = async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(event)) },
      cancel() { cancelled = true },
    }), { headers: { 'Content-Type': 'text/event-stream' } })
  }
  const result = await runTurn(
    'https://api.example.com/v1/chat/completions',
    'test-key',
    'test-model',
    [],
    [],
    () => undefined,
    { adapter: 'generic-openai', fetcher, maxOutputTokens: 4 },
  )
  assert.equal(requestBodies[0]?.max_tokens, 4)
  assert.equal(result.content.length, 32)
  assert.equal(result.finishReason, 'caller_limit')
  assert.equal(cancelled, true)
})

test('generic provider emits structured image and video content parts', { concurrency: false }, async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  const mediaRequests: Array<{ authorization: string; redirect?: RequestRedirect }> = []
  globalThis.fetch = async (input, init) => {
    if (input.toString() === 'https://media.example.com/clip.mp4') {
      mediaRequests.push({
        authorization: new Headers(init?.headers).get('authorization') ?? '',
        redirect: init?.redirect,
      })
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'video/mp4' } })
    }
    return Response.json({
      choices: [{
        finish_reason: 'stop',
        message: {
          content: [
            { type: 'text', text: '媒体已生成' },
            { type: 'output_image', b64_json: 'iVBORw0KGgo=' },
            { type: 'video_url', video_url: { url: 'https://media.example.com/clip.mp4' }, mime_type: 'video/mp4' },
          ],
        },
      }],
    })
  }
  const events: any[] = []
  const result = await runTurn(
    'https://api.example.com/v1/chat/completions',
    'test-key',
    'test-model',
    [],
    [],
    event => { events.push(event) },
    { adapter: 'generic-openai', fetcher: globalThis.fetch, mediaFetcher: globalThis.fetch },
  )

  assert.equal(result.content, '媒体已生成')
  assert.deepEqual(events.filter(event => event.media).map(event => event.media.type), ['image', 'video'])
  assert.match(events.find(event => event.media?.type === 'image')?.media.url ?? '', /^data:image\/png;base64,/)
  assert.match(events.find(event => event.media?.type === 'video')?.media.url ?? '', /^data:video\/mp4;base64,/)
  assert.deepEqual(mediaRequests, [{ authorization: '', redirect: 'manual' }])
})

test('generic agent loop shares a four-item remote media budget across rounds', async () => {
  let chatCalls = 0
  const mediaRequests: string[] = []
  const events: any[] = []
  const makeMedia = (offset: number) => Array.from({ length: 4 }, (_, index) => ({
    type: 'image_url',
    image_url: { url: `https://media.example.com/${offset + index}.png` },
  }))
  const fetcher = async () => {
    chatCalls++
    return Response.json({
      choices: [{
        finish_reason: chatCalls === 1 ? 'tool_calls' : 'stop',
        message: {
          content: makeMedia(chatCalls === 1 ? 0 : 4),
          ...(chatCalls === 1 ? {
            tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'noop', arguments: '{}' } }],
          } : {}),
        },
      }],
    })
  }
  const mediaFetcher = async (input: string | URL) => {
    mediaRequests.push(input.toString())
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } })
  }

  await runAgentLoop({
    url: 'https://api.example.com/v1/chat/completions',
    apiKey: 'test-key',
    model: 'test-model',
    adapter: 'generic-openai',
    thinking: false,
    messages: [{ role: 'user', content: 'generate' }],
    tools: [{ type: 'function', function: { name: 'noop', parameters: {} } }],
    emit: event => { events.push(event) },
    executeTool: async () => 'ok',
    maxRounds: 2,
    turnOptions: { fetcher, mediaFetcher },
  })

  assert.equal(chatCalls, 2)
  assert.deepEqual(mediaRequests, [0, 1, 2, 3].map(index => `https://media.example.com/${index}.png`))
  assert.equal(events.filter(event => event.media).length, 4)
})

test('generic provider accepts a structured image larger than the text response cap', { concurrency: false }, async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  const encoded = 'A'.repeat(4 * 1024 * 1024 + 4)
  globalThis.fetch = async () => Response.json({
    choices: [{
      finish_reason: 'stop',
      message: { content: [{ type: 'output_image', b64_json: encoded }] },
    }],
  })
  const events: any[] = []
  const result = await runTurn(
    'https://api.example.com/v1/chat/completions',
    'test-key',
    'test-model',
    [],
    [],
    event => { events.push(event) },
    { adapter: 'generic-openai', fetcher: globalThis.fetch },
  )

  assert.equal(result.failed, false)
  assert.equal(events.filter(event => event.media).length, 1)
  assert.equal(events.find(event => event.media)?.media.url.length, encoded.length + 'data:image/png;base64,'.length)
})
