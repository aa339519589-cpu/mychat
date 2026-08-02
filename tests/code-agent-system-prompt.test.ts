import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCodeSystem } from '../lib/code-agent/system-prompt'

test('workspace prompt uses the selected model name and excludes plan instructions', () => {
  const prompt = buildCodeSystem(
    'GPT-5.6 Sol Pro',
    'owner/repo',
    'bo',
    ['使用 pnpm'],
    'workspace',
    true,
  )

  assert.match(prompt, /你是「GPT-5\.6 Sol Pro」/)
  assert.match(prompt, /【Workspace 模式】/)
  assert.match(prompt, /当前仓库：owner\/repo/)
  assert.match(prompt, /【仓库记忆】/)
  assert.doesNotMatch(prompt, /【Plan 模式】/)
  assert.doesNotMatch(prompt, /小克/)
})

test('plan prompt is injected only for plan mode and omits repository memory', () => {
  const prompt = buildCodeSystem(
    'Claude Opus 5',
    null,
    'bo',
    ['不应进入 Plan Prompt'],
    'plan',
    false,
  )

  assert.match(prompt, /你是「Claude Opus 5」/)
  assert.match(prompt, /【Plan 模式】/)
  assert.doesNotMatch(prompt, /【Workspace 模式】/)
  assert.doesNotMatch(prompt, /【仓库记忆】/)
  assert.doesNotMatch(prompt, /不应进入 Plan Prompt/)
})
