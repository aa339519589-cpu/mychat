import test from 'node:test'
import assert from 'node:assert/strict'
import { buildModelContext } from '../lib/llm/context'
import { getModelCapability, MODEL_REGISTRY } from '../lib/llm/models'
import { buildProviderRequest } from '../lib/llm/provider-adapters'

const IMAGE = 'data:image/png;base64,aGVsbG8='

test('vision model receives text and image parts', () => {
  const context = buildModelContext([{
    id: 'message-1',
    role: 'user',
    content: '这张图是什么？',
    images: [IMAGE],
    imageSummary: '一张测试图片',
  }], getModelCapability('mimo-v2.5'))

  assert.equal(context[0].role, 'user')
  assert.ok(Array.isArray(context[0].content))
  assert.deepEqual(context[0].content, [
    { type: 'text', text: '这张图是什么？' },
    { type: 'image_url', image_url: { url: IMAGE } },
  ])
})

test('text model receives only text with the cached image summary', () => {
  const context = buildModelContext([{
    id: 'message-1',
    role: 'user',
    content: '继续分析',
    images: [IMAGE],
    imageSummary: '一张包含折线图的截图，峰值为 42。',
  }], getModelCapability('deepseek-v4-flash'))

  assert.equal(typeof context[0].content, 'string')
  assert.match(context[0].content as string, /内容摘要：一张包含折线图的截图，峰值为 42。/)
  assert.doesNotMatch(JSON.stringify(context), /image_url|data:image/)
})

test('text model strips embedded image parts and raw file fields defensively', () => {
  const context = buildModelContext([{
    role: 'user',
    content: [
      { type: 'text', text: '保留这段文字' },
      { type: 'image_url', image_url: { url: IMAGE } },
      { type: 'file', file: { data: 'raw-file-data' } },
    ],
    imageSummary: '图片摘要',
  }], getModelCapability('deepseek-v4-pro'))

  assert.equal(typeof context[0].content, 'string')
  assert.match(context[0].content as string, /^保留这段文字/)
  assert.doesNotMatch(JSON.stringify(context), /image_url|raw-file-data|data:image/)
})

test('registry declares capabilities and provider adapters for every model', () => {
  for (const model of Object.values(MODEL_REGISTRY)) {
    assert.equal(typeof model.supportsVision, 'boolean')
    assert.equal(typeof model.supportsImageInput, 'boolean')
    assert.ok(model.maxContext > 0)
    assert.match(model.provider.adapter, /-openai$/)
  }
})

test('MiMo adapter uses the provider-specific completion token field', () => {
  const request = buildProviderRequest('mimo-openai', {
    model: 'mimo-v2.5',
    messages: [],
    tools: [],
    thinking: false,
    apiKey: 'test-key',
  })

  assert.equal(request.body.max_completion_tokens, 65_536)
  assert.equal(request.body.max_tokens, undefined)
})
