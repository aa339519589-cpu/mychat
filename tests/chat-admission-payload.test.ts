import assert from 'node:assert/strict'
import test from 'node:test'
import {
  chatAdmissionMessages,
  chatAdmissionRequestBody,
  type RunChatStreamOptions,
} from '../components/literary-chat/chat-stream-service'

test('chat admission uploads only the current user turn', () => {
  const messages = [
    { id: '1', role: 'user' as const, content: 'old question' },
    { id: '2', role: 'assistant' as const, content: 'old answer'.repeat(10_000) },
    { id: '3', role: 'user' as const, content: 'current question' },
  ]

  assert.deepEqual(chatAdmissionMessages(messages), [messages[2]])
})

test('chat admission body keeps command metadata while omitting authoritative history', () => {
  const options = {
    tier: 'pro',
    endpoint: { id: 'endpoint-1' },
    modelId: 'model-1',
    reasoningEffort: 'high',
    messages: [
      { id: 'old-user', role: 'user', content: 'old question' },
      { id: 'old-assistant', role: 'assistant', content: 'old answer' },
      { id: 'current-user', role: 'user', content: 'current question' },
    ],
    attachments: [{ id: 'file-1' }],
    searchMode: 'web',
    historyRetrieval: true,
    renderEnabled: true,
    conversationId: 'conversation-1',
    generationId: 'generation-1',
    assistantMessageId: 'assistant-1',
    turn: { schemaVersion: 2, operation: 'append' },
  } as unknown as RunChatStreamOptions

  assert.deepEqual(chatAdmissionRequestBody(options), {
    tier: 'pro',
    endpointId: 'endpoint-1',
    modelId: 'model-1',
    reasoningEffort: 'high',
    messages: [{ id: 'current-user', role: 'user', content: 'current question' }],
    attachments: [{ id: 'file-1' }],
    searchMode: 'web',
    historyRetrieval: true,
    renderEnabled: true,
    conversationId: 'conversation-1',
    userMessageId: 'current-user',
    generationId: 'generation-1',
    assistantMessageId: 'assistant-1',
    generateImage: false,
    generateVideo: false,
    turn: { schemaVersion: 2, operation: 'append' },
  })
})
