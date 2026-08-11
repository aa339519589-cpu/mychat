import assert from 'node:assert/strict'
import test from 'node:test'
import { anthropicMessagesUrl } from '../lib/llm/anthropic-messages'
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

test('Claude Sonnet 5 uses adaptive thinking and output_config effort', () => {
  const { headers, body } = buildProviderRequest('anthropic-messages', {
    model: 'claude-sonnet-5',
    messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'hi' }],
    tools: [],
    thinking: false,
    apiKey: 'sk-test',
    authType: 'bearer',
    reasoningEffort: 'xhigh',
    maxOutputTokens: 40_000,
  })
  assert.equal(headers['anthropic-version'], '2023-06-01')
  assert.equal(headers.Authorization, 'Bearer sk-test')
  assert.equal(body.system, 'system')
  assert.deepEqual(body.thinking, { type: 'adaptive' })
  assert.deepEqual(body.output_config, { effort: 'xhigh' })
  assert.equal(body.reasoning_effort, undefined)
  assert.equal(body.max_tokens, 40_000)
})

test('Claude Sonnet 5 Off explicitly disables adaptive thinking', () => {
  const { body } = buildProviderRequest('anthropic-messages', {
    model: 'claude-sonnet-5',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    thinking: false,
    apiKey: 'sk-test',
    reasoningEffort: 'none',
  })
  assert.deepEqual(body.thinking, { type: 'disabled' })
  assert.equal(body.output_config, undefined)
})

test('Claude Fable 5 effort controls native adaptive thinking', () => {
  const { body } = buildProviderRequest('anthropic-messages', {
    model: 'claude-fable-5',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    thinking: false,
    apiKey: 'sk-test',
    reasoningEffort: 'max',
  })
  assert.deepEqual(body.thinking, { type: 'adaptive' })
  assert.deepEqual(body.output_config, { effort: 'max' })
})

test('Claude Haiku 4.5 maps token-budget presets to extended thinking', () => {
  const high = buildProviderRequest('anthropic-messages', {
    model: 'claude-haiku-4-5',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    thinking: false,
    apiKey: 'sk-test',
    reasoningEffort: 'high',
    maxOutputTokens: 40_000,
  }).body
  assert.deepEqual(high.thinking, { type: 'enabled', budget_tokens: 8_192 })
  assert.equal(high.output_config, undefined)

  const maximum = buildProviderRequest('anthropic-messages', {
    model: 'claude-haiku-4-5',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    thinking: false,
    apiKey: 'sk-test',
    reasoningEffort: 'max',
    maxOutputTokens: 40_000,
  }).body
  assert.deepEqual(maximum.thinking, { type: 'enabled', budget_tokens: 32_768 })
})

test('Claude Haiku 4.5 Off omits extended thinking', () => {
  const { body } = buildProviderRequest('anthropic-messages', {
    model: 'claude-haiku-4-5',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    thinking: false,
    apiKey: 'sk-test',
    reasoningEffort: 'none',
  })
  assert.equal(body.thinking, undefined)
  assert.equal(body.output_config, undefined)
})

test('Anthropic Messages URL preserves roots, v1 prefixes and complete endpoints', () => {
  assert.equal(anthropicMessagesUrl('https://kuaipao.pro'), 'https://kuaipao.pro/v1/messages')
  assert.equal(anthropicMessagesUrl('https://kuaipao.pro/v1'), 'https://kuaipao.pro/v1/messages')
  assert.equal(anthropicMessagesUrl('https://kuaipao.pro/v1/messages'), 'https://kuaipao.pro/v1/messages')
})

test('caller output limit is encoded for every provider family', () => {
  const common = {
    model: 'bounded-model',
    messages: [],
    tools: [],
    thinking: false,
    apiKey: 'key',
    maxOutputTokens: 64,
  }
  assert.equal(buildProviderRequest('generic-openai', common).body.max_tokens, 64)
  assert.equal(buildProviderRequest('deepseek-openai', common).body.max_tokens, 64)
  assert.equal(buildProviderRequest('mimo-openai', common).body.max_completion_tokens, 64)
})
