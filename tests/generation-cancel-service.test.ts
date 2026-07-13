import assert from 'node:assert/strict'
import test from 'node:test'
import { coordinateGenerationCancellation } from '../lib/generation/cancel-service'
import { createGeneration, getGeneration } from '../lib/generation/runtime'

test('a failed cancellation CAS never aborts the local provider runner', async () => {
  const entry = createGeneration({
    id: 'cancel-cas-unavailable',
    userId: 'cancel-user',
    conversationId: 'cancel-conversation',
    assistantMessageId: 'cancel-assistant',
  })
  const result = await coordinateGenerationCancellation({
    userId: 'cancel-user',
    generationId: 'cancel-cas-unavailable',
  }, {
    requestCancellation: async () => ({ ok: false, errorCode: 'database_error' }),
  })
  assert.deepEqual(result, { kind: 'unavailable' })
  assert.equal(entry.abort.signal.aborted, false)
})

test('the local runner is aborted only after the database returns a valid terminal winner', async () => {
  const entry = createGeneration({
    id: 'cancel-cas-winner',
    userId: 'cancel-user',
    conversationId: 'cancel-conversation',
    assistantMessageId: 'cancel-assistant-winner',
  })
  const result = await coordinateGenerationCancellation({
    userId: 'cancel-user',
    generationId: 'cancel-cas-winner',
  }, {
    requestCancellation: async () => ({
      ok: true,
      accepted: true,
      status: 'cancelled',
      content: 'canonical partial',
      thinking: '',
      sequence: 3,
      media: [],
    }),
  })
  assert.equal(result.kind, 'terminal')
  assert.equal(entry.abort.signal.aborted, true)
  assert.equal(getGeneration('cancel-cas-winner')?.record.status, 'cancelled')
  assert.equal(getGeneration('cancel-cas-winner')?.record.content, 'canonical partial')
})
