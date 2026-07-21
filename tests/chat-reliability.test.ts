import assert from 'node:assert/strict'
import test from 'node:test'
import { generationTerminalWarning } from '@/lib/generation-message'
import { retryableTurnStatus, runTurn, type RunTurnOptions } from '@/lib/llm/turn'

// Keep retry behavior deterministic so transient provider failures cannot regress silently.
const messages = [{ role: 'user' as const, content: 'hello' }]

async function runFailedTurn(fetcher: NonNullable<RunTurnOptions['fetcher']>, retryDelaysMs = [0, 0, 0]) {
  return runTurn(
    'https://provider.example/v1/chat/completions',
    'test-key',
    'test-model',
    messages,
    [],
    () => undefined,
    { adapter: 'generic-openai', fetcher, retryDelaysMs, emitErrors: false },
  )
}

test('retries only transient provider response statuses', () => {
  for (const status of [408, 425, 429, 500, 502, 503, 504]) {
    assert.equal(retryableTurnStatus(status), true, String(status))
  }
  for (const status of [200, 400, 401, 403, 404, 409, 422]) {
    assert.equal(retryableTurnStatus(status), false, String(status))
  }
})

test('retries transient provider responses before returning the terminal failure', async () => {
  let calls = 0
  const result = await runFailedTurn(async () => {
    calls += 1
    return new Response(calls < 3 ? 'temporary' : 'bad request', {
      status: calls < 3 ? 503 : 400,
    })
  }, [0, 1, 1])

  assert.equal(calls, 3)
  assert.equal(result.failed, true)
})

test('does not retry a permanent provider response', async () => {
  let calls = 0
  const result = await runFailedTurn(async () => {
    calls += 1
    return new Response('unauthorized', { status: 401 })
  })

  assert.equal(calls, 1)
  assert.equal(result.failed, true)
})

test('retries transport exceptions and eventually returns a provider response', async () => {
  let calls = 0
  const result = await runFailedTurn(async () => {
    calls += 1
    if (calls < 3) throw new TypeError('offline')
    return new Response('bad request', { status: 400 })
  })

  assert.equal(calls, 3)
  assert.equal(result.failed, true)
})

test('surfaces the last transport exception after the bounded retries', async () => {
  let calls = 0
  await assert.rejects(() => runFailedTurn(async () => {
    calls += 1
    throw new TypeError('offline')
  }), /offline/)
  assert.equal(calls, 3)
})

test('honors cancellation before a delayed retry', async () => {
  const controller = new AbortController()
  controller.abort(new Error('cancelled'))
  let calls = 0
  await assert.rejects(() => runTurn(
    'https://provider.example/v1/chat/completions',
    'test-key',
    'test-model',
    messages,
    [],
    () => undefined,
    {
      adapter: 'generic-openai',
      fetcher: async () => {
        calls += 1
        return new Response('unused', { status: 503 })
      },
      retryDelaysMs: [1],
      signal: controller.signal,
      emitErrors: false,
    },
  ), /cancelled/)
  assert.equal(calls, 0)
})

test('does not expose internal job errors in chat history', () => {
  assert.equal(generationTerminalWarning({
    id: 'generation-1',
    status: 'failed',
    sequence: 3,
    error: 'JOB_ATTEMPTS_EXHAUSTED',
  }), '这次回复没有生成成功，请点击重新生成')

  assert.equal(generationTerminalWarning({
    id: 'generation-2',
    status: 'failed',
    sequence: 4,
    error: '作业控制面暂时不可用',
  }), '这次回复没有生成成功，请点击重新生成')
})
