import assert from 'node:assert/strict'
import test from 'node:test'
import { buildProviderRequest } from '../lib/llm/provider-adapters'

test('generic-openai includes reasoning_effort low by default when set', () => {
  const { body } = buildProviderRequest('generic-openai', {
    model: 'grok-4.5',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    thinking: false,
    apiKey: 'sk-test',
    reasoningEffort: 'low',
  })
  assert.equal(body.model, 'grok-4.5')
  assert.equal(body.stream, true)
  assert.equal(body.reasoning_effort, 'low')
  assert.deepEqual(body.reasoning, { effort: 'low' })
  assert.equal(body.thinking, undefined)
})

test('generic-openai omits reasoning when effort not provided', () => {
  const { body } = buildProviderRequest('generic-openai', {
    model: 'grok-4.5',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    thinking: false,
    apiKey: 'sk-test',
  })
  assert.equal(body.reasoning_effort, undefined)
  assert.equal(body.reasoning, undefined)
})

test('deepseek adapter still uses thinking object, not reasoning_effort', () => {
  const { body } = buildProviderRequest('deepseek-openai', {
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    thinking: true,
    apiKey: 'sk-test',
    reasoningEffort: 'low',
  })
  assert.deepEqual(body.thinking, { type: 'enabled' })
  assert.equal(body.reasoning_effort, undefined)
})
