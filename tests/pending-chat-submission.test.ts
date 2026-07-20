import assert from 'node:assert/strict'
import test from 'node:test'
import {
  pendingSubmissionBody,
  readPendingChatSubmission,
  removePendingChatSubmission,
  savePendingChatSubmission,
} from '../components/literary-chat/pending-chat-submission'

const conversationId = '98000000-0000-4000-8000-000000000001'
const generationId = '98000000-0000-4000-8000-000000000002'
const assistantMessageId = '98000000-0000-4000-8000-000000000003'

test('pending chat command preserves the exact durable generation identity', async () => {
  const body = { conversationId, generationId, assistantMessageId, messages: [] }
  await savePendingChatSubmission({
    schemaVersion: 1,
    conversationId,
    generationId,
    assistantMessageId,
    path: '/api/chat',
    serializedBody: JSON.stringify(body),
    createdAt: Date.now(),
  })

  const saved = await readPendingChatSubmission(conversationId)
  assert.ok(saved)
  assert.deepEqual(pendingSubmissionBody(saved), body)
  assert.equal(await removePendingChatSubmission(conversationId, 'another-generation'), false)
  assert.ok(await readPendingChatSubmission(conversationId))
  assert.equal(await removePendingChatSubmission(conversationId, generationId), true)
  assert.equal(await readPendingChatSubmission(conversationId), null)
})

test('malformed pending commands are rejected before persistence', async () => {
  await savePendingChatSubmission({
    schemaVersion: 1,
    conversationId,
    generationId,
    assistantMessageId,
    path: '/api/chat',
    serializedBody: JSON.stringify({ conversationId, generationId: 'wrong', assistantMessageId }),
    createdAt: Date.now(),
  })
  assert.equal(await readPendingChatSubmission(conversationId), null)
})
