import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AuthoritativeContextError,
  compileAuthoritativeMessages,
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

test('the current user message is never silently truncated', () => {
  assert.throws(
    () => compileAuthoritativeMessages([row('current', 'x'.repeat(200))], 'current', 100),
    (error: unknown) => error instanceof AuthoritativeContextError
      && error.code === 'CONTEXT_TOO_LARGE',
  )
})
