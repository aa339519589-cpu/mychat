import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isInstantReplyCandidate } from '../lib/chat/instant-reply'
import type { RawMsg } from '../lib/llm/types'

function candidate(content: string, overrides: Partial<Parameters<typeof isInstantReplyCandidate>[0]> = {}) {
  const messages: RawMsg[] = [{ id: 'user-1', role: 'user', content }]
  return isInstantReplyCandidate({
    messages,
    searchMode: 'off',
    deepResearch: false,
    inProject: false,
    ...overrides,
  })
}

test('accepts only strict greeting and connectivity prompts', () => {
  assert.equal(candidate('你好'), true)
  assert.equal(candidate('Hello!'), true)
  assert.equal(candidate('测试'), true)
  assert.equal(candidate('👋'), true)
})

test('rejects prompts that need normal context or tools', () => {
  assert.equal(candidate('你好，帮我分析这个项目'), false)
  assert.equal(candidate('你好', { searchMode: 'web' }), false)
  assert.equal(candidate('你好', { deepResearch: true }), false)
  assert.equal(candidate('你好', { attachments: [{}] }), false)
  assert.equal(candidate('你好', { inProject: true }), false)
})

test('rejects visual user turns', () => {
  const messages: RawMsg[] = [{ id: 'user-1', role: 'user', content: '你好', images: ['https://example.com/a.png'] }]
  assert.equal(isInstantReplyCandidate({
    messages,
    searchMode: 'off',
    deepResearch: false,
    inProject: false,
  }), false)
})
