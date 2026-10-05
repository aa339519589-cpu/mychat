import assert from 'node:assert/strict'
import test from 'node:test'
import { validateChatRequest } from '../lib/llm/chat-request'
import { ChatModelSelectionError, resolveChatModelSelection } from '../lib/chat/model-selection'
import type { ModelCatalogItem } from '../lib/model-catalog'
import { catalogForModelPolicy } from '../lib/chat/model-policy'

const claude: ModelCatalogItem = {
  id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5', provider: 'Anthropic',
  access: 'premium', outputKind: 'chat', promptPrice: 3, completionPrice: 15,
  contextLength: 200000, vision: true, tools: true, flagship: true,
  reasoningEfforts: ['none', 'high'], defaultReasoningEffort: 'none', reasoningMandatory: false,
}
const options = { tier: '绝句', modelPolicy: 'claude-only' as const, modelId: claude.id, supabase: null, userId: null, allowPremium: true }
test('scoped catalog contains only Claude chat models while legacy catalog is preserved', () => {
  const models = [claude, { ...claude, id: 'openai/gpt-5.4', provider: 'OpenAI' }, { ...claude, provider: 'Other' }, { ...claude, outputKind: 'image' as const }]
  assert.deepEqual(catalogForModelPolicy(models, 'claude-only'), [claude])
  assert.equal(catalogForModelPolicy(models, undefined), models)
})
function dependencies(value: ModelCatalogItem | null, calls: string[] = []) {
  return {
    getCatalogModel: async (id: string) => { calls.push(id); return value },
    getOwnedEndpoint: async () => { throw new Error('custom endpoint must never resolve') },
    resolveEndpointKey: () => { throw new Error('custom key must never resolve') },
    validateEndpointNetwork: async () => { throw new Error('custom network must never resolve') },
  }
}
test('Claude request policy rejects missing identity, aliases, other vendors and custom endpoints', () => {
  const base = { messages: [{ role: 'user', content: 'hello' }], modelPolicy: 'claude-only' }
  for (const modelId of [undefined, 'openai/gpt-5.4', 'deepseek/deepseek-v4-pro', 'anthropic/claude-opus-latest', 'vendor/claude-sonnet-5', 'anthropic/claude-sonnet-5:free']) {
    assert.throws(() => validateChatRequest({ ...base, modelId }), /Choose an available Claude model/)
  }
  assert.throws(() => validateChatRequest({ ...base, modelId: claude.id, endpointId: '10000000-0000-4000-8000-000000000001' }), /Choose an available Claude model/)
  for (const modelPolicy of [null, '', 'any', true, {}]) assert.throws(() => validateChatRequest({ ...base, modelId: claude.id, modelPolicy }), /modelPolicy/)
  assert.equal(validateChatRequest({ ...base, modelId: claude.id }).modelPolicy, 'claude-only')
  assert.doesNotThrow(() => validateChatRequest({ messages: base.messages }))
})
test('worker model selection enforces Claude policy before credentials or catalog access', async () => {
  const calls: string[] = []
  for (const modelId of [undefined, 'openai/gpt-5.4', 'deepseek/deepseek-v4-pro']) {
    await assert.rejects(resolveChatModelSelection({ ...options, modelId }, dependencies(claude, calls)),
      (error: unknown) => error instanceof ChatModelSelectionError && error.status === 400)
  }
  await assert.rejects(resolveChatModelSelection({ ...options, endpointId: 'custom' }, dependencies(claude, calls)))
  assert.deepEqual(calls, [])
})
test('unavailable or mismatched Claude catalog entries fail without selecting a fallback', async () => {
  for (const model of [null, { ...claude, id: 'openai/gpt-5.4' }, { ...claude, provider: 'OpenAI' }, { ...claude, outputKind: 'image' as const }]) {
    const calls: string[] = []
    await assert.rejects(resolveChatModelSelection(options, dependencies(model, calls)),
      (error: unknown) => error instanceof ChatModelSelectionError && (error.status === 404 || error.status === 409))
    assert.deepEqual(calls, [claude.id])
  }
})
test('valid Claude selection retains exact identity, reasoning and transport', async () => {
  const previous = process.env.OPENROUTER_API_KEY
  process.env.OPENROUTER_API_KEY = 'test-only-key'
  try {
    const selection = await resolveChatModelSelection({ ...options, reasoningEffort: 'high' }, dependencies(claude))
    assert.equal(selection.model, claude.id)
    assert.equal(selection.reasoningEffort, 'high')
    assert.equal(selection.capability.id, claude.id)
    assert.equal(selection.capability.provider.adapter, 'openrouter-openai')
    assert.equal(selection.outputKind, 'chat')
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = previous
  }
})
