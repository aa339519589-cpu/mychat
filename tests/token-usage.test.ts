import assert from 'node:assert/strict'
import test from 'node:test'
import { TurnAccumulator } from '../lib/llm/turn-accumulator'
import {
  addTokenUsage,
  normalizeTokenUsage,
  providerTokenUsage,
} from '../lib/token-usage'

test('provider usage reads exact OpenAI and Responses API token fields', () => {
  assert.deepEqual(providerTokenUsage({ prompt_tokens: 12_345, completion_tokens: 678 }), {
    inputTokens: 12_345,
    outputTokens: 678,
  })
  assert.deepEqual(providerTokenUsage({ input_tokens: 91, output_tokens: 17 }), {
    inputTokens: 91,
    outputTokens: 17,
  })
})

test('token usage accepts only exact non-negative integers', () => {
  assert.deepEqual(normalizeTokenUsage({ inputTokens: 0, outputTokens: 42 }), {
    inputTokens: 0,
    outputTokens: 42,
  })
  assert.equal(normalizeTokenUsage({ inputTokens: 1.5, outputTokens: 2 }), null)
  assert.equal(normalizeTokenUsage({ inputTokens: 1 }), null)
  assert.equal(providerTokenUsage({ prompt_tokens: '10', completion_tokens: 2 }), null)
})

test('multi-round usage adds input and output independently', () => {
  assert.deepEqual(
    addTokenUsage(
      { inputTokens: 100, outputTokens: 20 },
      { inputTokens: 140, outputTokens: 35 },
    ),
    { inputTokens: 240, outputTokens: 55 },
  )
})

test('a repeated cumulative usage event does not double count one provider request', () => {
  const accumulator = new TurnAccumulator({
    generic: false,
    model: 'test-model',
    emit: () => undefined,
    timingEnabled: false,
    startedAt: 0,
  })
  const usage = { prompt_tokens: 321, completion_tokens: 45, total_tokens: 366 }
  accumulator.handle({ usage })
  accumulator.handle({ usage })
  const result = accumulator.finish({ sawDone: true, callerLimitReached: false })
  assert.equal(result.totalTokens, 366)
  assert.deepEqual(result.tokenUsage, { inputTokens: 321, outputTokens: 45 })
})
