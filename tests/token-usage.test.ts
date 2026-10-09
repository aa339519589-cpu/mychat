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


test('provider cache and reasoning details are retained without changing legacy quota totals', () => {
  const usage = providerTokenUsage({ input_tokens: 12, output_tokens: 30,
    cache_read_input_tokens: 500, cache_creation_input_tokens: 100,
    cache_creation: { ephemeral_5m_input_tokens: 80, ephemeral_1h_input_tokens: 20 } })
  assert.deepEqual(usage, { inputTokens: 12, outputTokens: 30, totalInputTokens: 612,
    cachedInputTokens: 500, cacheCreationInputTokens: 100,
    cacheCreation5mInputTokens: 80, cacheCreation1hInputTokens: 20 })
  assert.deepEqual(normalizeTokenUsage(usage), usage)
  assert.deepEqual(providerTokenUsage({ prompt_tokens: 600, completion_tokens: 50,
    prompt_tokens_details: { cached_tokens: 500 }, completion_tokens_details: { reasoning_tokens: 35 } }),
  { inputTokens: 600, outputTokens: 50, totalInputTokens: 600, cachedInputTokens: 500, reasoningOutputTokens: 35 })
})

test('missing provider cache fields remain unknown and partial aggregates are not reported as complete', () => {
  const partial = providerTokenUsage({ input_tokens: 12, output_tokens: 30, cache_read_input_tokens: 500 })!
  assert.equal(partial.totalInputTokens, undefined)
  assert.equal(partial.cacheCreationInputTokens, undefined)
  assert.equal(addTokenUsage(partial, { inputTokens: 4, outputTokens: 5 }).cachedInputTokens, undefined)
  assert.equal(addTokenUsage(partial, partial).cachedInputTokens, 1000)
})
