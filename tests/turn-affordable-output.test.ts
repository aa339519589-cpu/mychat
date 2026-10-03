import assert from 'node:assert/strict'
import test from 'node:test'
import { runTurn } from '../lib/llm/turn'

test('OpenRouter credit admission retries once with affordable output on the same model', async () => {
  const bodies: Array<Record<string, unknown>> = []
  const keys: Array<string | null> = []
  const result = await runTurn('https://openrouter.ai/api/v1/chat/completions', 'test-key',
    'openai/audit', [{ role: 'user', content: 'hello' }], [], () => undefined, {
      adapter: 'openrouter-openai', maxOutputTokens: 40_000, retryDelaysMs: [0], idempotencyNamespace: 'audit',
      fetcher: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        keys.push(new Headers(init?.headers).get('Idempotency-Key'))
        if (bodies.length === 1) return Response.json({ error: {
          message: 'You requested up to 40000 tokens, but can only afford 33315. To increase, add credits',
        } }, { status: 402 })
        return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'hello back' } }],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } })
      },
    })
  assert.equal(result.failed, false)
  assert.equal(result.content, 'hello back')
  assert.deepEqual(bodies.map(body => [body.model, body.max_completion_tokens]),
    [['openai/audit', 40_000], ['openai/audit', 29_983]])
  assert.ok(keys.every(Boolean))
  assert.notEqual(keys[0], keys[1])
})

test('credit failures stay bounded and unrelated or tiny credit allowances fail closed', async () => {
  for (const message of ['Billing account disabled', 'can only afford 100 tokens', 'can only afford 50000 tokens']) {
    let calls = 0
    const result = await runTurn('https://openrouter.ai/api/v1/chat/completions', 'test-key',
      'openai/audit', [{ role: 'user', content: 'hello' }], [], () => undefined, {
        adapter: 'openrouter-openai', maxOutputTokens: 40_000, retryDelaysMs: [0],
        fetcher: async () => { calls++; return Response.json({ error: { message } }, { status: 402 }) },
      })
    assert.equal(calls, 1)
    assert.equal(result.failed, true)
    assert.ok(result.error)
  }
  let calls = 0
  const result = await runTurn('https://openrouter.ai/api/v1/chat/completions', 'test-key',
    'openai/audit', [], [], () => undefined, {
      adapter: 'openrouter-openai', maxOutputTokens: 40_000, retryDelaysMs: [0],
      fetcher: async () => { calls++; return Response.json({ error: { message: 'can only afford 33315 tokens' } }, { status: 402 }) },
    })
  assert.equal(calls, 2)
  assert.equal(result.failed, true)
})

test('custom endpoints do not receive OpenRouter credit adaptation', async () => {
  let calls = 0
  const result = await runTurn('https://model.example/v1/chat/completions', 'test-key', 'custom', [], [], () => undefined, {
    adapter: 'generic-openai', maxOutputTokens: 40_000,
    fetcher: async () => { calls++; return Response.json({ error: { message: 'can only afford 33315 tokens' } }, { status: 402 }) },
  })
  assert.equal(calls, 1)
  assert.equal(result.failed, true)
})
