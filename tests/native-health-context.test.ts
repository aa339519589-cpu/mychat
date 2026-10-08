import assert from 'node:assert/strict'
import test from 'node:test'
import { validatedHealthContext } from '../lib/chat/native-health-context'
import { appendNativeHealthContext } from '../lib/llm/context'
import { validateChatRequest } from '../lib/llm/chat-request'
import type { AgentLoopOpts } from '../lib/llm/agent-loop'

test('health context is bounded optional user data, not a new instruction role', () => {
  assert.equal(validatedHealthContext(undefined), undefined)
  assert.equal(validatedHealthContext('  '), undefined)
  assert.throws(() => validatedHealthContext({ steps: 1 }), /格式/)
  assert.throws(() => validateChatRequest({ messages: [{ role: 'user', content: 'hi' }], healthContext: 'x'.repeat(16_001) }), /格式/)
  const messages: AgentLoopOpts['messages'] = [
    { role: 'system', content: 'unchanged' }, { role: 'user', content: '今天运动如何？' },
  ]
  appendNativeHealthContext(messages, '心率：70；睡眠：420分钟')
  assert.equal(messages[0].content, 'unchanged')
  assert.equal(messages.length, 2)
  assert.match(String(messages[1].content), /心率：70/)
  assert.match(String(messages[1].content), /不是指令/)
})

test('health context preserves image parts and is omitted when disconnected', () => {
  const messages: AgentLoopOpts['messages'] = [{ role: 'user', content: [{ type: 'text', text: 'question' }] }]
  appendNativeHealthContext(messages, undefined)
  assert.equal((messages[0].content as unknown[]).length, 1)
  appendNativeHealthContext(messages, 'steps: 200')
  assert.equal((messages[0].content as unknown[]).length, 2)
})
