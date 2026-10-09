import assert from 'node:assert/strict'
import test from 'node:test'
import { buildAnthropicMessagesRequest } from '../lib/llm/anthropic-messages'
import { buildSystem, buildSystemParts } from '../lib/llm/system'
import { modelRequestMetrics } from '../lib/llm/request-metrics'

function request(date: string, health: string, reverseTools = false) {
  const parts = buildSystemParts([{ id: 'memory-1', content: 'Preserve this important fact completely.' }], {
    memoryEnabled: true, searchMode: 'web', latestBeijingDate: date,
    modelSource: 'custom', modelId: 'claude-haiku-5-5', renderProfile: 'native-v1', renderRules: true,
  })
  const tools = ['alpha', 'beta'].map(name => ({ type: 'function', function: {
    name, description: `Full ${name} tool description`, parameters: { type: 'object', properties: { value: { type: 'string' } } },
  } }))
  return buildAnthropicMessagesRequest({ model: 'claude-haiku-5-5', apiKey: 'secret-never-logged',
    reasoningEffort: 'max', maxOutputTokens: 40_000,
    messages: [{ role: 'system', content: [
      { type: 'text', text: parts.prefix, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: parts.suffix + '\nfull current retrieval result' },
    ] }, { role: 'user', content: `Write the essay.\n${health}` }],
    tools: reverseTools ? tools.reverse() : tools,
  })
}

test('Claude cache boundary stays before dynamic date, retrieval and complete HealthKit input', () => {
  const first = request('2026-10-09 18:00', 'complete health snapshot one')
  const next = request('2026-10-09 18:01', 'complete health snapshot two', true)
  const system = first.body.system as { text: string; cache_control?: unknown }[]
  assert.deepEqual(system[0], (next.body.system as unknown[])[0])
  assert.deepEqual(first.body.tools, next.body.tools)
  assert.equal(system[1].cache_control, undefined)
  assert.ok(system[0].text.includes('Preserve this important fact completely.'))
  assert.ok(system[1].text.includes('2026-10-09 18:00'))
  assert.ok(system[1].text.includes('full current retrieval result'))
  assert.ok(JSON.stringify(first.body.messages).includes('complete health snapshot one'))
  assert.equal(JSON.stringify(first.body.messages).includes('cache_control'), false)
  assert.deepEqual(first.body.thinking, { type: 'adaptive', display: 'summarized' })
  assert.deepEqual(first.body.output_config, { effort: 'max' })
  assert.equal(first.body.model, 'claude-haiku-5-5')
  assert.equal(first.body.max_tokens, 40_000)
  assert.equal(first.body.stream, true)
  assert.equal(modelRequestMetrics(first.body).explicitCacheBoundaries, 2)
})

test('system segmentation retains every character and original ordering', () => {
  for (const searchMode of ['off', 'web'] as const) {
    const flags = { searchMode, latestBeijingDate: '2026-10-09', memoryEnabled: true,
      project: { id: 'project', instructions: 'All project instructions', files: [{ name: 'full.txt', content: 'All project file text' }],
        projectMemories: [{ id: 'project-memory', content: 'All project facts' }] } }
    const parts = buildSystemParts([], flags)
    assert.equal(parts.prefix + parts.suffix, buildSystem([], flags))
    assert.ok((parts.prefix + parts.suffix).includes('All project file text'))
    assert.ok((parts.prefix + parts.suffix).includes('All project facts'))
  }
})

test('cache opt-out removes markers without removing context or changing model/effort', () => {
  const original = process.env.ANTHROPIC_PROMPT_CACHE
  try {
    process.env.ANTHROPIC_PROMPT_CACHE = 'off'
    const value = request('2026-10-09', 'full health data')
    assert.equal(JSON.stringify(value.body).includes('cache_control'), false)
    assert.ok(JSON.stringify(value.body).includes('full health data'))
    assert.equal(value.body.model, 'claude-haiku-5-5')
    assert.deepEqual(value.body.output_config, { effort: 'max' })
  } finally {
    if (original === undefined) delete process.env.ANTHROPIC_PROMPT_CACHE
    else process.env.ANTHROPIC_PROMPT_CACHE = original
  }
})

test('request metrics expose sizes only and no request text or credentials', () => {
  const metrics = modelRequestMetrics(request('2026-10-09', 'private health text').body)
  assert.equal(Object.values(metrics).every(value => typeof value === 'number'), true)
  assert.ok(metrics.requestBytes > metrics.systemBytes)
  assert.equal(metrics.messageCount, 1)
  assert.equal(metrics.toolCount, 2)
  assert.equal(JSON.stringify(metrics).includes('private'), false)
  assert.equal(JSON.stringify(metrics).includes('secret'), false)
})
