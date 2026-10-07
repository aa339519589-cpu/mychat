import assert from 'node:assert/strict'
import test from 'node:test'
import { runAgentLoop } from '../lib/llm/agent-loop'
import { ProviderResponseError } from '../lib/llm/turn-response'
import type { ModelMessage, ModelToolDefinition } from '../lib/llm/types'

const tool: ModelToolDefinition = {
  type: 'function',
  function: { name: 'lookup', parameters: { type: 'object', properties: {} } },
}

function completion(content: string, tokens = 7, finishReason = 'stop', toolCalls = false): Response {
  return Response.json({
    choices: [{
      finish_reason: finishReason,
      message: {
        content,
        ...(toolCalls ? { tool_calls: [{ id: 'call-1', function: { name: 'lookup', arguments: '{}' } }] } : {}),
      },
    }],
    usage: { total_tokens: tokens },
  })
}

function options(fetcher: typeof fetch) {
  return {
    url: 'https://model.example/v1/chat/completions',
    apiKey: 'test',
    model: 'model',
    adapter: 'generic-openai' as const,
    thinking: false,
    messages: [{ role: 'user', content: 'reply' }] as ModelMessage[],
    tools: [] as ModelToolDefinition[],
    emit: () => undefined,
    executeTool: async () => 'result',
    turnOptions: { fetcher },
  }
}

test('final model output is announced while usage durability is still pending', async () => {
  let startUsage!: () => void
  let releaseUsage!: () => void
  const usageStarted = new Promise<void>(resolve => { startUsage = resolve })
  const usageDurable = new Promise<void>(resolve => { releaseUsage = resolve })
  let completions = 0
  let settled = false
  const running = runAgentLoop({
    ...options(async () => completion('short reply')),
    onOutputCompleted: () => { completions++ },
    onUsage: async total => {
      assert.equal(total, 7)
      startUsage()
      await usageDurable
    },
  }).finally(() => { settled = true })
  await usageStarted
  try {
    assert.equal(completions, 1)
    assert.equal(settled, false, 'output completion must not acknowledge durable job success')
  } finally { releaseUsage() }
  assert.equal((await running).totalTokens, 7)
  assert.equal(completions, 1)
})

test('tool output waits for tool execution and announces only the final model reply', async () => {
  let calls = 0
  let completions = 0
  let executed = false
  await runAgentLoop({
    ...options(async () => ++calls === 1
      ? completion('', 2, 'tool_calls', true)
      : completion('finished', 3)),
    tools: [tool],
    executeTool: async () => {
      assert.equal(completions, 0)
      executed = true
      return 'result'
    },
    onOutputCompleted: () => {
      assert.equal(executed, true)
      completions++
    },
    onUsage: total => {
      assert.equal(completions, total === 2 ? 0 : 1)
    },
  })
  assert.equal(completions, 1)
})

test('length continuation remains active until the remaining output arrives', async () => {
  let calls = 0
  let completions = 0
  await runAgentLoop({
    ...options(async () => ++calls === 1
      ? completion('part one', 2, 'length')
      : completion('part two', 3)),
    autoContinue: { maxContinuations: 1 },
    onOutputCompleted: () => { completions++ },
    onUsage: total => assert.equal(completions, total === 2 ? 0 : 1),
  })
  assert.equal(calls, 2)
  assert.equal(completions, 1)
})

test('leaked markup recovery does not announce completion before returning to the outer loop', async () => {
  let calls = 0
  let completions = 0
  await runAgentLoop({
    ...options(async () => completion(
      ++calls === 1 ? '<function_calls>hidden</function_calls>'
        : calls === 2 ? 'recovered reply' : 'final reply',
      1,
    )),
    maxRounds: 3,
    leakedRetry: true,
    onOutputCompleted: () => { completions++ },
    onUsage: total => assert.equal(completions, total < 3 ? 0 : 1),
  })
  assert.equal(calls, 3)
  assert.equal(completions, 1)
})

test('idle continuation makes its final decision before output completion', async () => {
  let calls = 0
  let completions = 0
  await runAgentLoop({
    ...options(async () => completion(++calls === 1 ? 'partial' : 'done', 1)),
    idleContinuation: { maxContinuations: 1, prompt: () => 'continue' },
    onOutputCompleted: () => { completions++ },
    onUsage: () => assert.equal(completions, 0),
  })
  assert.equal(calls, 2)
  assert.equal(completions, 1)
})

test('generic compatibility fallback does not announce a rejected request as complete', async () => {
  let calls = 0
  let completions = 0
  await runAgentLoop({
    ...options(async () => ++calls === 1
      ? new Response('unsupported tools', { status: 400 })
      : completion('compatible reply')),
    tools: [tool],
    onOutputCompleted: () => { completions++ },
    onUsage: total => assert.equal(completions, total === 0 ? 0 : 1),
  })
  assert.equal(calls, 2)
  assert.equal(completions, 1)
})

test('accounting rejection still fails the operation after visible model output has completed', async () => {
  let completions = 0
  await assert.rejects(runAgentLoop({
    ...options(async () => completion('reply')),
    onOutputCompleted: () => { completions++ },
    onUsage: async () => { throw new Error('ledger rejected') },
  }), /ledger rejected/)
  assert.equal(completions, 1)
})

test('permanent provider rejection never announces model output completion', async () => {
  let completions = 0
  await assert.rejects(runAgentLoop({
    ...options(async () => new Response('rejected', { status: 403 })),
    onOutputCompleted: () => { completions++ },
  }), error => error instanceof ProviderResponseError && error.status === 403 && !error.retryable)
  assert.equal(completions, 0)
})
