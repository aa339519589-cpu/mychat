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

test('chat admission body handles a minimal turn without optional client metadata', () => {
  const message = { role: 'assistant', content: 'fallback' }
  const options = {
    tier: 'free',
    endpoint: null,
    modelId: null,
    reasoningEffort: null,
    messages: [message],
    searchMode: 'off',
    historyRetrieval: false,
    renderEnabled: false,
    conversationId: 'conversation-2',
    assistantMessageId: 'assistant-2',
  } as unknown as RunChatStreamOptions

  const result = chatAdmissionRequestBody(options)
  assert.deepEqual(result.messages, [message])
  assert.equal('userMessageId' in result, false)
  assert.equal('endpointId' in result, false)
  assert.equal('attachments' in result && result.attachments !== undefined, false)
  assert.equal('turn' in result, false)
})
