import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveChatModelSelection } from '../lib/chat/model-selection'
import { resolveCodeModelSelection } from '../lib/code-agent/model-selection'
import { parseCodeChatRequest } from '../lib/code-agent/request'
import { customModelReasoningProfile } from '../lib/model-reasoning'
import { chatRequestSearchMode } from '../lib/search-mode'
import { shouldReserveChatModelTrial } from '../lib/chat/model-access'

test('missing Chat and Code model selects the actual shared Haiku transport with medium thinking', async t => {
  const names = ['CLAUDE_API_BASE_URL', 'CLAUDE_API_KEY', 'CLAUDE_HAIKU_55_MODEL'] as const
  const previous = new Map(names.map(name => [name, process.env[name]]))
  process.env.CLAUDE_API_BASE_URL = 'https://claude-gateway.example/v1'
  process.env.CLAUDE_API_KEY = 'synthetic-github-token'
  delete process.env.CLAUDE_HAIKU_55_MODEL
  t.after(() => {
    for (const name of names) { const value = previous.get(name); if (value === undefined) delete process.env[name]; else process.env[name] = value }
  })
  const request = parseCodeChatRequest({ messages: [{ role: 'user', content: 'Explain this code' }] })
  assert.equal(request.modelId, 'anthropic/claude-haiku-5.5')
  const chat = await resolveChatModelSelection({ tier: '绝句', supabase: null, userId: null, allowPremium: true })
  const code = await resolveCodeModelSelection({ modelId: request.modelId, supabase: null, userId: null, allowPremium: true })
  for (const selection of [chat, code]) {
    assert.equal(selection.model, 'claude-haiku-5-5')
    assert.equal(selection.capability.provider.adapter, 'anthropic-messages')
    assert.equal(selection.capability.provider.id, 'anthropic')
    assert.equal(selection.reasoningEffort, 'medium')
    assert.equal(selection.thinking, true)
    assert.equal(selection.accessClass, 'premium')
  }
  const off = await resolveChatModelSelection({ tier: '绝句', reasoningEffort: 'none', supabase: null, userId: null, allowPremium: true })
  assert.equal(off.thinking, false)
  assert.equal(off.reasoningEffort, 'none')
  assert.equal(customModelReasoningProfile('claude-haiku-5-5').defaultReasoningEffort, 'medium')
  assert.equal(parseCodeChatRequest({ modelId: 'explicit-model', messages: [{ role: 'user', content: 'hi' }] }).modelId, 'explicit-model')
})

test('Chat default online mode preserves explicit current and legacy opt-outs', () => {
  assert.equal(chatRequestSearchMode(undefined, undefined), 'web')
  assert.equal(chatRequestSearchMode('off', true), 'off')
  assert.equal(chatRequestSearchMode(undefined, false), 'off')
  assert.equal(chatRequestSearchMode(undefined, 'off'), 'off')
  assert.equal(chatRequestSearchMode('web', false), 'web')
})

test('a default premium model obeys the same entitlement as an explicitly chosen one', () => {
  assert.equal(shouldReserveChatModelTrial({ customEndpoint: false, accessClass: 'premium' }, false), true)
  assert.equal(shouldReserveChatModelTrial({ customEndpoint: false, accessClass: 'premium' }, true), false)
  assert.equal(shouldReserveChatModelTrial({ customEndpoint: true, accessClass: 'legacy' }, false), false)
  assert.equal(shouldReserveChatModelTrial({ customEndpoint: false, accessClass: 'quota' }, false), false)
})
