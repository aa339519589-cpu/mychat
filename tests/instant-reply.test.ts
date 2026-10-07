import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isInstantReplyCandidate } from '../lib/chat/instant-reply'
import type { RawMsg } from '../lib/llm/types'

function candidate(content: string, overrides: Partial<Parameters<typeof isInstantReplyCandidate>[0]> = {}) {
  const messages: RawMsg[] = [{ id: 'user-1', role: 'user', content }]
  return isInstantReplyCandidate({
    messages,
    searchMode: 'off',
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

test('accepts pure laughter without routing meaningful short requests through the greeting path', () => {
  for (const text of ['哈哈', '哈哈哈', '哈哈哈！', 'hahaha', 'HaHa!']) {
    assert.equal(candidate(text), true, text)
  }
  for (const text of ['哈哈哈，接着上面的内容说', '哈哈哈帮我搜索一下', '哈利波特', '哈'.repeat(25), '仅回复 OK。']) {
    assert.equal(candidate(text), false, text)
  }
  assert.equal(candidate('哈哈哈', { searchMode: 'web' }), false)
  assert.equal(candidate('哈哈哈', { attachments: [{}] }), false)
  assert.equal(candidate('哈哈哈', { inProject: true }), false)
})

test('rejects prompts that need normal context or tools', () => {
  assert.equal(candidate('你好，帮我分析这个项目'), false)
  assert.equal(candidate('你好', { searchMode: 'web' }), false)
  assert.equal(candidate('你好', { attachments: [{}] }), false)
  assert.equal(candidate('你好', { inProject: true }), false)
})

test('rejects visual user turns', () => {
  const messages: RawMsg[] = [{ id: 'user-1', role: 'user', content: '你好', images: ['https://example.com/a.png'] }]
  assert.equal(isInstantReplyCandidate({
    messages,
    searchMode: 'off',
    inProject: false,
  }), false)
})
