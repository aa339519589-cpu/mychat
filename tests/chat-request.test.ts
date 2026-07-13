import assert from 'node:assert/strict'
import test from 'node:test'
import { RequestError } from '../lib/api/request'
import { requireDurableChatIdentity, validateChatRequest } from '../lib/llm/chat-request'

const identity = {
  conversationId: '10000000-0000-4000-8000-000000000001',
  generationId: '20000000-0000-4000-8000-000000000001',
  assistantMessageId: '30000000-0000-4000-8000-000000000001',
}

test('general chat requires one complete durable generation identity', () => {
  const complete = validateChatRequest({ messages: [{ role: 'user', content: 'hello' }], ...identity })
  assert.doesNotThrow(() => requireDurableChatIdentity(complete))

  for (const partial of [
    {},
    { conversationId: identity.conversationId },
    { ...identity, assistantMessageId: undefined },
  ]) {
    const body = validateChatRequest({ messages: [{ role: 'user', content: 'hello' }], ...partial })
    assert.throws(
      () => requireDurableChatIdentity(body),
      (error: unknown) => error instanceof RequestError && error.status === 400,
    )
  }
})
