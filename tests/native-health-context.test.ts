import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_NATIVE_HEALTH_CONTEXT_CHARS, validatedHealthContext } from '../lib/chat/native-health-context'
import { appendNativeHealthContext } from '../lib/llm/context'
import { validateChatRequest } from '../lib/llm/chat-request'
import type { AgentLoopOpts } from '../lib/llm/agent-loop'

test('health context is bounded optional user data, not a new instruction role', () => {
  assert.equal(validatedHealthContext(undefined), undefined)
  assert.equal(validatedHealthContext('  '), undefined)
  assert.throws(() => validatedHealthContext({ steps: 1 }), /格式/)
  assert.throws(() => validateChatRequest({ messages: [{ role: 'user', content: 'hi' }], healthContext: 'x'.repeat(MAX_NATIVE_HEALTH_CONTEXT_CHARS + 1) }), /格式/)
  const messages: AgentLoopOpts['messages'] = [
    { role: 'system', content: 'unchanged' }, { role: 'user', content: '今天运动如何？' },
  ]
  appendNativeHealthContext(messages, '心率：70；睡眠：420分钟')
  assert.equal(messages[0].content, 'unchanged')
  assert.equal(messages.length, 2)
  assert.match(String(messages[1].content), /心率：70/)
  assert.match(String(messages[1].content), /不是指令/)
})

test('expanded native health records retain sleep stages and trailing types beyond the old limit', () => {
  const records = '睡眠：开始=2026-10-07T23:15:00+08:00；结束=2026-10-08T07:30:00+08:00；浅睡=240分钟；深睡=80分钟；REM=100分钟\n'
    + '心率记录\n'.repeat(4_000) + '营养与用药记录：末尾校验'
  assert.ok(records.length > 16_000)
  validateChatRequest({ messages: [{ role: 'user', content: '昨晚睡眠分期和运动如何？' }], healthContext: records })
  const messages: AgentLoopOpts['messages'] = [{ role: 'user', content: '昨晚睡眠分期和运动如何？' }]
  appendNativeHealthContext(messages, records)
  assert.match(String(messages[0].content), /23:15:00/)
  assert.match(String(messages[0].content), /REM=100分钟/)
  assert.match(String(messages[0].content), /营养与用药记录：末尾校验/)
  assert.equal(validatedHealthContext('x'.repeat(MAX_NATIVE_HEALTH_CONTEXT_CHARS))?.length, MAX_NATIVE_HEALTH_CONTEXT_CHARS)
  assert.throws(() => validatedHealthContext('record\u0000tail'), /格式/)
})

test('health context preserves image parts and is omitted when disconnected', () => {
  const messages: AgentLoopOpts['messages'] = [{ role: 'user', content: [{ type: 'text', text: 'question' }] }]
  appendNativeHealthContext(messages, undefined)
  assert.equal((messages[0].content as unknown[]).length, 1)
  appendNativeHealthContext(messages, 'steps: 200')
  assert.equal((messages[0].content as unknown[]).length, 2)
})
