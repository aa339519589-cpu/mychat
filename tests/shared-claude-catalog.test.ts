import assert from 'node:assert/strict'
import test from 'node:test'
import { getSharedClaudeCatalog } from '../lib/shared-claude-catalog'
import { ChatModelSelectionError, resolveChatModelSelection } from '../lib/chat/model-selection'

test('shared Claude catalog uses gateway IDs and gateway prices independently of OpenRouter', async () => {
  const names = ['CLAUDE_API_BASE_URL', 'CLAUDE_API_KEY', 'CLAUDE_API_AUTH_TYPE', 'OPENROUTER_API_KEY'] as const
  const previous = new Map(names.map(name => [name, process.env[name]]))
  const originalFetch = globalThis.fetch
  process.env.CLAUDE_API_BASE_URL = 'https://claude-gateway.example/v1'
  process.env.CLAUDE_API_KEY = 'shared-key'
  process.env.CLAUDE_API_AUTH_TYPE = 'bearer'
  delete process.env.OPENROUTER_API_KEY
  try {
    const runtimeIDs = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']
    globalThis.fetch = async (url, init) => {
      assert.equal(url, 'https://claude-gateway.example/v1/models')
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer shared-key')
      return Response.json({ data: runtimeIDs.map(id => ({
        id, context_length: 1_000_000, pricing: { prompt: '0.00000008', completion: '0.0000004' },
        architecture: { input_modalities: ['text', 'image'] }, supported_parameters: ['tools'],
      })) })
    }
    const models = await getSharedClaudeCatalog()
    assert.deepEqual(models.map(model => model.name), ['Claude Fable 5.1', 'Claude Opus 5.5', 'Claude Sonnet 5.5', 'Claude Haiku 5.5'])
    assert.equal(models.at(-1)?.id, 'anthropic/claude-haiku-5.5')
    assert.equal(models.at(-1)?.promptPrice, 0.08)
    assert.equal(models.at(-1)?.completionPrice, 0.4)
    assert.equal(models.at(-1)?.vision, true)
    assert.equal(models.at(-1)?.tools, true)
    const code = await resolveChatModelSelection({ tier: '绝句', modelId: 'claude-haiku-5-5',
      supabase: null, userId: null, allowPremium: true, reasoningEffort: 'low' })
    assert.equal(code.model, 'claude-haiku-5-5')
    assert.equal(code.capability.provider.id, 'anthropic')
  } finally {
    globalThis.fetch = originalFetch
    for (const name of names) {
      const value = previous.get(name)
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

test('missing shared Claude configuration fails closed even when OpenRouter has a key', async () => {
  const names = ['CLAUDE_API_BASE_URL', 'ANTHROPIC_BASE_URL', 'OPENROUTER_API_KEY'] as const
  const previous = new Map(names.map(name => [name, process.env[name]]))
  delete process.env.CLAUDE_API_BASE_URL
  delete process.env.ANTHROPIC_BASE_URL
  process.env.OPENROUTER_API_KEY = 'must-not-be-used'
  try {
    await assert.rejects(resolveChatModelSelection({ tier: '绝句', modelId: 'anthropic/claude-haiku-5.5',
      supabase: null, userId: null, allowPremium: true }),
    (error: unknown) => error instanceof ChatModelSelectionError && error.status === 500
      && error.message === '共享 Claude 模型服务尚未配置')
  } finally {
    for (const name of names) {
      const value = previous.get(name)
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})
