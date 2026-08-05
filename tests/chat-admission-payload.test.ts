import assert from 'node:assert/strict'
import test from 'node:test'
import { chatAdmissionMessages } from '../components/literary-chat/chat-stream-service'

test('chat admission uploads only the current user turn', () => {
  const messages = [
    { id: '1', role: 'user' as const, content: 'old question' },
    { id: '2', role: 'assistant' as const, content: 'old answer'.repeat(10_000) },
    { id: '3', role: 'user' as const, content: 'current question' },
  ]

  assert.deepEqual(chatAdmissionMessages(messages), [messages[2]])
})
