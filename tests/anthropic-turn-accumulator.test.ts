import assert from 'node:assert/strict'
import test from 'node:test'
import { AnthropicTurnAccumulator } from '../lib/llm/anthropic-turn-accumulator'
import type { ChatEvent } from '../lib/llm/events'
import { anthropicThinkingIsSummary } from '../lib/llm/anthropic-messages'

function accumulator(events: ChatEvent[]) {
  return new AnthropicTurnAccumulator({
    model: 'claude-sonnet-5',
    emit: event => events.push(event),
    timingEnabled: false,
    startedAt: Date.now(),
    maxOutputTokens: 40_000,
  })
}

test('Claude provider summaries are visible before final text while signed blocks stay intact', () => {
  const events: ChatEvent[] = []
  const value = new AnthropicTurnAccumulator({ model: 'claude-fable-5-1', summarizedThinking: true,
    emit: event => events.push(event), timingEnabled: false, startedAt: 0 })
  value.handle({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })
  value.handle({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '核对文件目录' } })
  assert.deepEqual(events, [{ reasoningSummary: '核对文件目录' }])
  value.handle({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'encrypted' } })
  value.handle({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '首' } })
  assert.deepEqual(events.at(-1), { text: '首' })
  assert.equal(anthropicThinkingIsSummary('anthropic/claude-sonnet-5.5'), true)
  assert.equal(anthropicThinkingIsSummary('claude-3-7-sonnet'), false)
  assert.equal(anthropicThinkingIsSummary('unknown-private-endpoint'), false)
})

test('Anthropic stream preserves signed thinking and tool_use blocks', () => {
  const events: ChatEvent[] = []
  const value = accumulator(events)
  value.handle({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } })
  value.handle({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })
  value.handle({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'plan' } })
  value.handle({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed-value' } })
  value.handle({ type: 'content_block_stop', index: 0 })
  value.handle({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} } })
  value.handle({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"q":"x"}' } })
  value.handle({ type: 'content_block_stop', index: 1 })
  value.handle({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } })
  value.handle({ type: 'message_stop' })

  const result = value.finish({ sawDone: false, callerLimitReached: false })
  assert.equal(result.failed, false)
  assert.equal(result.finishReason, 'tool_calls')
  assert.equal(result.totalTokens, 15)
  assert.equal(result.reasoningContent, 'plan')
  assert.deepEqual(result.toolCalls, [{ id: 'toolu_1', name: 'lookup', args: '{"q":"x"}' }])
  assert.deepEqual(result.assistantMessage?.anthropic_content, [
    { type: 'thinking', thinking: 'plan', signature: 'signed-value' },
    { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 'x' } },
  ])
  assert.deepEqual(events, [{ thinking: 'plan' }])
})

test('Anthropic text deltas stream as visible output and map max_tokens to length', () => {
  const events: ChatEvent[] = []
  const value = accumulator(events)
  value.handle({ type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 0 } } })
  value.handle({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  value.handle({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } })
  value.handle({ type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 2 } })
  const result = value.finish({ sawDone: false, callerLimitReached: false })
  assert.equal(result.content, 'hello')
  assert.equal(result.finishReason, 'length')
  assert.equal(result.totalTokens, 5)
  assert.deepEqual(events, [{ text: 'hello' }])
})
