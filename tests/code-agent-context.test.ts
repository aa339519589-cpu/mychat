import assert from 'node:assert/strict'
import test from 'node:test'
import {
  codeAgentMode,
  codeContextPolicy,
  trimCodeContextMessages,
} from '../lib/code-agent/context'
import type { CodeChatMessage } from '../lib/code-agent/request'

function messages(count: number): CodeChatMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message-${index}`,
  }))
}

test('Code context uses 16 messages in plan mode and 32 in workspace mode', () => {
  const history = messages(40)
  const plan = trimCodeContextMessages(history, 'plan')
  const workspace = trimCodeContextMessages(history, 'workspace')

  assert.equal(codeAgentMode(false), 'plan')
  assert.equal(codeAgentMode(true), 'workspace')
  assert.equal(codeContextPolicy('plan').messages, 16)
  assert.equal(codeContextPolicy('workspace').messages, 32)
  assert.equal(plan.length, 16)
  assert.equal(plan[0]?.content, 'message-24')
  assert.equal(plan.at(-1)?.content, 'message-39')
  assert.equal(workspace.length, 32)
  assert.equal(workspace[0]?.content, 'message-8')
  assert.equal(workspace.at(-1)?.content, 'message-39')
})

test('Code byte budget keeps the newest message instead of injecting the full history', () => {
  const history: CodeChatMessage[] = [
    { role: 'user', content: '旧'.repeat(24_000) },
    { role: 'assistant', content: '中'.repeat(24_000) },
    { role: 'user', content: '新'.repeat(24_000) },
  ]
  const result = trimCodeContextMessages(history, 'plan')

  assert.equal(result.length, 1)
  assert.equal(result[0]?.content, history[2]?.content)
})
