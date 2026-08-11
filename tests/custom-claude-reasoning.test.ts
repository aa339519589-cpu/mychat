import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ChatModelSelectionError,
  resolveChatModelSelection,
} from '../lib/chat/model-selection'
import type { ModelEndpointRow } from '../lib/model-endpoint-server'
import { customModelReasoningProfile } from '../lib/model-reasoning'

function endpoint(model: string): ModelEndpointRow {
  return {
    id: 'endpoint-id',
    user_id: 'user-id',
    name: model,
    protocol: 'openai',
    base_url: 'https://kuaipao.pro/v1',
    api_key: 'encrypted',
    model,
    output_kind: 'chat',
    auth_type: 'bearer',
  }
}

async function selection(model: string, reasoningEffort?: string) {
  return resolveChatModelSelection({
    tier: '绝句',
    endpointId: 'endpoint-id',
    reasoningEffort,
    supabase: {} as never,
    userId: 'user-id',
  }, {
    getOwnedEndpoint: async () => endpoint(model),
    resolveEndpointKey: () => 'secret',
    validateEndpointNetwork: async value => value,
  })
}

test('custom model profiles exactly match the supported Claude controls', () => {
  const sonnet = customModelReasoningProfile('claude-sonnet-5')
  assert.equal(sonnet.reasoningMode, 'adaptive')
  assert.deepEqual(sonnet.reasoningEfforts, ['none', 'low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(sonnet.defaultReasoningEffort, 'high')

  const fable = customModelReasoningProfile('claude-fable-5')
  assert.equal(fable.reasoningMandatory, true)
  assert.deepEqual(fable.reasoningEfforts, ['low', 'medium', 'high', 'xhigh', 'max'])

  const haiku = customModelReasoningProfile('claude-haiku-4-5')
  assert.equal(haiku.reasoningMode, 'budget')
  assert.deepEqual(haiku.reasoningEfforts, ['none', 'low', 'medium', 'high', 'xhigh', 'max'])
})

test('Sonnet 5 defaults to native high effort and uses Messages transport', async () => {
  const result = await selection('claude-sonnet-5')
  assert.equal(result.reasoningEffort, 'high')
  assert.equal(result.thinking, true)
  assert.equal(result.capability.provider.adapter, 'anthropic-messages')
  assert.equal(result.capability.provider.baseUrl, 'https://kuaipao.pro/v1/messages')
})

test('Sonnet 5 permits an explicit Off selection', async () => {
  const result = await selection('claude-sonnet-5', 'none')
  assert.equal(result.reasoningEffort, 'none')
  assert.equal(result.thinking, false)
})

test('Fable 5 rejects Off and defaults to high adaptive thinking', async () => {
  const enabled = await selection('claude-fable-5')
  assert.equal(enabled.reasoningEffort, 'high')
  assert.equal(enabled.thinking, true)
  await assert.rejects(
    selection('claude-fable-5', 'none'),
    (error: unknown) => error instanceof ChatModelSelectionError
      && error.status === 409
      && error.message.includes('不能选择 Off'),
  )
})

test('Haiku 4.5 accepts every explicit token-budget preset', async () => {
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    const enabled = await selection('claude-haiku-4-5', effort)
    assert.equal(enabled.reasoningEffort, effort)
    assert.equal(enabled.thinking, true)
  }
})

test('unknown custom models do not expose fabricated reasoning controls', async () => {
  const plain = await selection('some-openai-compatible-model')
  assert.equal(plain.reasoningEffort, null)
  assert.equal(plain.capability.provider.adapter, 'generic-openai')
  await assert.rejects(
    selection('some-openai-compatible-model', 'low'),
    (error: unknown) => error instanceof ChatModelSelectionError
      && error.status === 409,
  )
})
