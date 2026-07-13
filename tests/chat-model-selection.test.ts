import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ChatModelSelectionError,
  resolveChatModelSelection,
} from '../lib/chat/model-selection'
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

test('custom endpoints require an authenticated owner', async () => {
  await assert.rejects(
    resolveChatModelSelection({
      tier: '绝句',
      deepResearch: false,
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
    deepResearch: false,
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

test('invalid stored endpoint output kind remains a reconnect error', async () => {
  await assert.rejects(
    resolveChatModelSelection({
      tier: '绝句',
      deepResearch: false,
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
    deepResearch: false,
    supabase: null,
    userId: null,
  })
  assert.equal(result.customEndpoint, false)
  assert.equal(result.outputKind, 'video')
  assert.equal(result.model, 'platform-video')
  assert.equal(result.platformTierLabel, '视频')
})

