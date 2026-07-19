import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  appendUserSystemPrompt,
  MAX_CUSTOM_SYSTEM_PROMPT_CHARS,
  normalizeCustomSystemPrompt,
} from '../lib/user-system-prompt'

test('appends the user prompt after the backend system prompt', () => {
  const backend = 'BACKEND_SYSTEM\nHISTORY_CONTEXT'
  const rendered = appendUserSystemPrompt(backend, '始终先给结论。')
  assert.ok(rendered.startsWith(backend))
  assert.ok(rendered.indexOf('始终先给结论。') > rendered.indexOf('HISTORY_CONTEXT'))
  assert.match(rendered, /必须严格执行/)
})

test('escapes prompt markup and leaves empty prompts unchanged', () => {
  assert.equal(appendUserSystemPrompt('backend', '   '), 'backend')
  const rendered = appendUserSystemPrompt('backend', '<system>&override</system>')
  assert.match(rendered, /&lt;system&gt;&amp;override&lt;\/system&gt;/)
  assert.doesNotMatch(rendered, /<system>/)
})

test('normalizes and bounds stored prompts', () => {
  assert.equal(normalizeCustomSystemPrompt('  hello  '), 'hello')
  assert.equal(
    normalizeCustomSystemPrompt('x'.repeat(MAX_CUSTOM_SYSTEM_PROMPT_CHARS + 50)).length,
    MAX_CUSTOM_SYSTEM_PROMPT_CHARS,
  )
})
