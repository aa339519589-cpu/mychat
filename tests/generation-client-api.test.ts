import assert from 'node:assert/strict'
import test from 'node:test'
import { requestClientGenerationCancellation } from '../components/literary-chat/generation-api'

test('cancel acknowledgement reports the database winner without inferring cancellation', async () => {
  const completed = await requestClientGenerationCancellation('g-completed', {
    fetcher: async () => Response.json({
      ok: true,
      status: 'completed',
      terminal: {
        status: 'completed', content: 'answer', thinking: '', sequence: 4, error: null, media: [],
      },
    }),
  })
  const cancelled = await requestClientGenerationCancellation('g-cancelled', {
    fetcher: async () => Response.json({
      ok: true,
      status: 'cancelled',
      terminal: {
        status: 'cancelled', content: 'partial', thinking: '', sequence: 5, error: null, media: [],
      },
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
