import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSystem } from '../lib/llm/system'

test('render rules are injected only when renderRules flag is set', () => {
  const enabled = buildSystem([], { renderRules: true })
  assert.ok(enabled.includes('<vega>'))
  assert.ok(enabled.includes('<mermaid>'))
  assert.ok(enabled.includes('<artifact>'))

  const disabled = buildSystem([], { renderRules: false })
  assert.ok(!disabled.includes('<vega>'))
  assert.ok(!disabled.includes('<artifact>'))
})

test('base system no longer carries unconditional render rules', () => {
  const system = buildSystem([], {})
  assert.ok(!system.includes('<vega>'))
  assert.ok(!system.includes('<artifact>'))
})
