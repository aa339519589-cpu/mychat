import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ChatModelSelectionError,
  resolveChatModelSelection,
} from '../lib/chat/model-selection'
import { resolveCodeModelSelection } from '../lib/code-agent/model-selection'
import type { ModelEndpointRow } from '../lib/model-endpoint-server'

const endpoint: ModelEndpointRow = {
  id: 'endpoint-id',
  user_id: 'user-id',
  name: 'Image endpoint',
  protocol: 'openai',
  base_url: 'https://media.example/v1',
  api_key: 'encrypted',
  model: 'image-model',
  output_kind: 'image',
  auth_type: 'x-api-key',
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

test('custom endpoints require an authenticated owner', async () => {
  await assert.rejects(
    resolveChatModelSelection({
      tier: '绝句',
      endpointId: 'endpoint-id',
      supabase: null,
      userId: null,
    }),
    (error: unknown) => error instanceof ChatModelSelectionError
      && error.status === 401
      && error.message === '请先登录后使用自定义模型',
  )
})

test('custom endpoint selection resolves credentials, network and media kind once', async () => {
  const calls: string[] = []
  const result = await resolveChatModelSelection({
    tier: '绝句',
    endpointId: 'endpoint-id',
    supabase: {} as never,
    userId: 'user-id',
  }, {
    getOwnedEndpoint: async () => { calls.push('owned'); return endpoint },
    resolveEndpointKey: () => { calls.push('key'); return 'secret' },
    validateEndpointNetwork: async () => { calls.push('network'); return 'https://safe.example/v1' },
  })

  assert.deepEqual(calls, ['owned', 'key', 'network'])
  assert.equal(result.customEndpoint, true)
  assert.equal(result.outputKind, 'image')
  assert.equal(result.authType, 'x-api-key')
  assert.equal(result.apiKey, 'secret')
  assert.equal(result.capability.provider.baseUrl, 'https://safe.example/v1')
})

test('custom chat endpoint preserves selected reasoning effort', async () => {
  const chatEndpoint = { ...endpoint, output_kind: 'chat' as const, model: 'claude-sonnet-5' }
  const dependencies = {
    getOwnedEndpoint: async () => chatEndpoint,
    resolveEndpointKey: () => 'secret',
    validateEndpointNetwork: async () => 'https://safe.example/v1',
  }
  const high = await resolveChatModelSelection({
    tier: '绝句', endpointId: 'endpoint-id', reasoningEffort: 'high', supabase: {} as never, userId: 'user-id',
  }, dependencies)
  assert.equal(high.reasoningEffort, 'high')
  assert.equal(high.thinking, true)

  const off = await resolveChatModelSelection({
    tier: '绝句', endpointId: 'endpoint-id', reasoningEffort: 'none', supabase: {} as never, userId: 'user-id',
  }, dependencies)
  assert.equal(off.reasoningEffort, 'none')
  assert.equal(off.thinking, false)
})

test('custom Sonnet 5 endpoint accepts XHigh and rejects unsupported levels', async () => {
  const dependencies = {
    getOwnedEndpoint: async () => ({ ...endpoint, output_kind: 'chat', model: 'claude-sonnet-5' }),
    resolveEndpointKey: () => 'secret',
    validateEndpointNetwork: async () => 'https://safe.example/v1',
  }
  const xhigh = await resolveChatModelSelection({
    tier: '绝句', endpointId: 'endpoint-id', reasoningEffort: 'xhigh', supabase: {} as never, userId: 'user-id',
  }, dependencies)
  assert.equal(xhigh.reasoningEffort, 'xhigh')
  assert.equal(xhigh.thinking, true)

  await assert.rejects(
    resolveChatModelSelection({
      tier: '绝句', endpointId: 'endpoint-id', reasoningEffort: 'minimal', supabase: {} as never, userId: 'user-id',
    }, dependencies),
    (error: unknown) => error instanceof ChatModelSelectionError
      && error.status === 409
      && error.message === '当前自定义模型不支持所选思考深度',
  )
})

test('invalid stored endpoint output kind remains a reconnect error', async () => {
  await assert.rejects(
    resolveChatModelSelection({
      tier: '绝句',
      endpointId: 'endpoint-id',
      supabase: {} as never,
      userId: 'user-id',
    }, {
      getOwnedEndpoint: async () => ({ ...endpoint, output_kind: 'audio' }),
      resolveEndpointKey: () => 'unused',
      validateEndpointNetwork: async value => value,
    }),
    (error: unknown) => error instanceof ChatModelSelectionError
      && error.status === 409
      && error.message === '自定义模型用途无效，请在设置中重新连接',
  )
})

test('platform media tiers do not depend on the chat model API key', async () => {
  const result = await resolveChatModelSelection({
    tier: '录像',
    supabase: null,
    userId: null,
  })
  assert.equal(result.customEndpoint, false)
  assert.equal(result.outputKind, 'video')
  assert.equal(result.model, 'platform-video')
  assert.equal(result.platformTierLabel, '视频')
})

test('curated DeepSeek chat models use the official DeepSeek transport', async () => {
  const previousDeepSeekKey = process.env.DEEPSEEK_API_KEY
  const previousOpenRouterKey = process.env.OPENROUTER_API_KEY
  process.env.DEEPSEEK_API_KEY = 'deepseek-direct-key'
  delete process.env.OPENROUTER_API_KEY
  try {
    const result = await resolveChatModelSelection({
      tier: '绝句',
      modelId: 'deepseek/deepseek-v4-flash-0731',
      reasoningEffort: 'medium',
      supabase: null,
      userId: null,
    })
    assert.equal(result.model, 'deepseek-v4-flash')
    assert.equal(result.apiKey, 'deepseek-direct-key')
    assert.equal(result.capability.provider.id, 'deepseek')
    assert.equal(result.capability.provider.adapter, 'deepseek-openai')
    assert.equal(result.capability.provider.baseUrl, 'https://api.deepseek.com')
    assert.equal(result.capability.provider.apiKeyEnv, 'DEEPSEEK_API_KEY')
    assert.equal(result.thinking, true)
  } finally {
    restoreEnvironment('DEEPSEEK_API_KEY', previousDeepSeekKey)
    restoreEnvironment('OPENROUTER_API_KEY', previousOpenRouterKey)
  }
})

test('DeepSeek Code selection bypasses OpenRouter and keeps official credentials', async () => {
  const previousDeepSeekKey = process.env.DEEPSEEK_API_KEY
  const previousOpenRouterKey = process.env.OPENROUTER_API_KEY
  process.env.DEEPSEEK_API_KEY = 'deepseek-code-key'
  delete process.env.OPENROUTER_API_KEY
  try {
    const result = await resolveCodeModelSelection({
      modelId: 'deepseek/deepseek-v4-pro',
      reasoningEffort: 'high',
      supabase: null,
      userId: null,
      allowPremium: true,
    })
    assert.equal(result.model, 'deepseek-v4-pro')
    assert.equal(result.apiKey, 'deepseek-code-key')
    assert.equal(result.capability.provider.id, 'deepseek')
    assert.equal(result.capability.provider.baseUrl, 'https://api.deepseek.com')
    assert.notEqual(result.capability.provider.id, 'openrouter')
  } finally {
    restoreEnvironment('DEEPSEEK_API_KEY', previousDeepSeekKey)
    restoreEnvironment('OPENROUTER_API_KEY', previousOpenRouterKey)
  }
})