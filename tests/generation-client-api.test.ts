import assert from 'node:assert/strict'
import test from 'node:test'
import { requestClientGenerationCancellation } from '../components/literary-chat/generation-job-actions'

test('cancel acknowledgement reports the database winner without inferring cancellation', async () => {
  const completed = await requestClientGenerationCancellation('g-completed', {
    fetcher: async () => Response.json({
      ok: true,
      status: 'completed',
      result: { content: 'answer', thinking: '', media: [] },
      eventSeq: 4,
    }),
  })
  const cancelled = await requestClientGenerationCancellation('g-cancelled', {
    fetcher: async () => Response.json({
      ok: true,
      status: 'cancelled',
      result: { content: 'partial', thinking: '', media: [] },
      eventSeq: 5,
    }),
  })
  assert.equal(completed.status, 'completed')
  assert.equal(completed.content, 'answer')
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.content, 'partial')
})

test('cancel coordination failure is surfaced and never treated as cancelled', async () => {
  await assert.rejects(
    requestClientGenerationCancellation('g-unavailable', {
      fetcher: async () => Response.json({ error: 'unavailable' }, { status: 503 }),
    }),
    /generation_cancel_503/,
  )
})
