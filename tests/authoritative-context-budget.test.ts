import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AuthoritativeContextError,
  compileAuthoritativeMessages,
  MAX_CONTEXT_MESSAGES,
  MAX_MEMORIES,
  MAX_MESSAGE_HISTORY_BYTES,
  MAX_PROJECT_FILES,
  type MessageRow,
} from '../lib/chat/authoritative-context'

function row(id: string, content: string): MessageRow {
  return {
    id,
    role: 'user',
    content,
    images: null,
    created_at: '2026-07-14T00:00:00.000Z',
  }
}

test('authoritative history keeps a contiguous recent suffix within its byte budget', () => {
  const messages = compileAuthoritativeMessages([
    row('current', 'new'),
    row('recent', 'r'.repeat(80)),
    row('old', 'o'.repeat(80)),
  ], 'current', 300)

  assert.deepEqual(messages.map(message => message.id), ['recent', 'current'])
})

test('interactive context limits keep history, memory, and project payloads bounded', () => {
  assert.equal(MAX_CONTEXT_MESSAGES, 48)
  assert.equal(MAX_MESSAGE_HISTORY_BYTES, 128 * 1024)
  assert.equal(MAX_MEMORIES, 200)
  assert.equal(MAX_PROJECT_FILES, 8)
})

test('the current user message is never silently truncated', () => {
  assert.throws(
    () => compileAuthoritativeMessages([row('current', 'x'.repeat(200))], 'current', 100),
    (error: unknown) => error instanceof AuthoritativeContextError
      && error.code === 'CONTEXT_TOO_LARGE',
  )
})

test('a normal photo larger than 128 KiB reaches the vision context unchanged', () => {
  const photo = 'data:image/jpeg;base64,' + 'A'.repeat(220_000)
  const current = { ...row('photo', '请描述图片'), images: { refs: [photo] } }
  const messages = compileAuthoritativeMessages([current, row('previous', '原来的上下文')], 'photo')
  assert.equal(messages.length, 2)
  assert.deepEqual(messages[1]?.images, [photo])
  assert.equal(messages[1]?.content, '请描述图片')
})

test('embedded image parts use the image budget instead of masquerading as 200k text tokens', () => {
  const photo = 'data:image/png;base64,' + 'A'.repeat(240_000)
  const previous = { ...row('previous', ''), content_parts: [
    { type: 'text', text: '前面的图片' },
    { type: 'image_url', image_url: { url: photo } },
  ] }
  const messages = compileAuthoritativeMessages([row('current', '继续描述'), previous], 'current')
  assert.equal(messages.length, 2)
  assert.deepEqual(messages[0]?.content, previous.content_parts)
})

test('image transport remains bounded even though it has a separate budget', () => {
  const current = { ...row('photo', '图片'), images: { refs: ['data:image/jpeg;base64,' + 'A'.repeat(8_000_001)] } }
  assert.throws(() => compileAuthoritativeMessages([current], 'photo'),
    (error: unknown) => error instanceof AuthoritativeContextError && error.code === 'CONTEXT_TOO_LARGE')
})
