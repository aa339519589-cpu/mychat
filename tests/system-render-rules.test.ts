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

test('web search prompt follows searchMode', () => {
  const enabled = buildSystem([], {
    searchMode: 'web',
    latestBeijingDate: '2026-08-02',
    memoryEnabled: false,
  })
  assert.ok(enabled.includes('【联网搜索规则】'))
  assert.ok(enabled.includes('当前用户已经开启联网。'))
  assert.ok(enabled.includes('2026-08-02 北京时间'))

  const disabled = buildSystem([], { searchMode: 'off', memoryEnabled: false })
  assert.ok(!disabled.includes('【联网搜索规则】'))
  assert.ok(!disabled.includes('当前用户已经开启联网。'))
  assert.ok(!disabled.includes('联网搜索'))
})

test('model identity uses the real model name and MyChat product name', () => {
  const platform = buildSystem([], {
    memoryEnabled: false,
    modelSource: 'platform',
    tierLabel: 'GPT-5.5',
  })
  assert.ok(platform.includes('被问模型时只答：“我是MyChat的GPT-5.5。”'))
  assert.ok(!platform.includes('Mytrend'))
  assert.ok(!platform.includes('快速 / 均衡 / 深度 / 视觉'))
  assert.ok(!platform.includes('平台内置模型档位'))

  const custom = buildSystem([], {
    memoryEnabled: false,
    modelSource: 'custom',
    modelId: 'deepseek/deepseek-v4-pro',
  })
  assert.ok(custom.includes('我是MyChat的deepseek/deepseek-v4-pro。'))
  assert.ok(!custom.includes('Mytrend'))
})

test('memory prompt and stored memories follow memoryEnabled', () => {
  const memories = [{ id: 'memory-1', content: '长期偏好', timestamp: '2026-08-02T00:00:00Z' }]
  const enabled = buildSystem(memories, { memoryEnabled: true })
  assert.ok(enabled.includes('【Memory 规则】'))
  assert.ok(enabled.includes('当前用户已经开启 Memory：长期记忆。'))
  assert.ok(enabled.includes('全局记忆工具'))
  assert.ok(enabled.includes('<memory id="memory-1"'))
  assert.ok(enabled.includes('长期偏好'))

  const disabled = buildSystem(memories, { memoryEnabled: false })
  assert.ok(!disabled.includes('【Memory 规则】'))
  assert.ok(!disabled.includes('Memory：长期记忆'))
  assert.ok(!disabled.includes('记忆工具'))
  assert.ok(!disabled.includes('本次已关闭记忆功能'))
  assert.ok(!disabled.includes('<memory'))
  assert.ok(!disabled.includes('长期偏好'))
})

test('project memories are omitted when memory is disabled', () => {
  const project = {
    id: 'project-1',
    name: '测试项目',
    instructions: '保留项目设定',
    projectMemories: [{ id: 'project-memory-1', content: '项目长期记忆' }],
    files: [],
  }
  const enabled = buildSystem([], { memoryEnabled: true, project })
  assert.ok(enabled.includes('项目级记忆工具'))
  assert.ok(enabled.includes('<project_memory id="project-memory-1"'))

  const disabled = buildSystem([], { memoryEnabled: false, project })
  assert.ok(disabled.includes('保留项目设定'))
  assert.ok(!disabled.includes('项目级记忆工具'))
  assert.ok(!disabled.includes('<project_memory'))
  assert.ok(!disabled.includes('项目长期记忆'))
})
