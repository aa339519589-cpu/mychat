import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSystem } from '../lib/llm/system'

test('render rules are injected only when renderRules flag is set', () => {
  const enabled = buildSystem([], { renderRules: true })
  assert.ok(enabled.includes('【渲染模式】'))
  assert.ok(enabled.includes('【数学公式】'))
  assert.ok(enabled.includes('<vega>'))
  assert.ok(enabled.includes('<mermaid>'))
  assert.ok(enabled.includes('<artifact>'))

  const disabled = buildSystem([], { renderRules: false })
  assert.ok(!disabled.includes('【渲染模式】'))
  assert.ok(!disabled.includes('【数学公式】'))
  assert.ok(!disabled.includes('<vega>'))
  assert.ok(!disabled.includes('<artifact>'))
})

test('base system carries no rendering capability or format instructions', () => {
  const system = buildSystem([], {})
  assert.ok(!system.includes('Artifact：面板渲染'))
  assert.ok(!system.includes('可视化渲染'))
  assert.ok(!system.includes('【数学公式】'))
  assert.ok(!system.includes('<vega>'))
  assert.ok(!system.includes('<artifact>'))
})
