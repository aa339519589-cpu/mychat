import assert from 'node:assert/strict'
import test from 'node:test'
import { requestClientGenerationCancellation } from '../components/literary-chat/generation-job-actions'
import {
  canStartNextTurn,
  isOutputStreaming,
  isRunning,
  isSettling,
  reduceClientGenerationState,
} from '../lib/generation-client'

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


test('client generation keeps durable running separate from visible output streaming', () => {
  const conversationId = 'conversation'
  const generationId = 'generation'
  let state = reduceClientGenerationState({}, conversationId, {
    status: 'running',
    generationId,
    assistantMessageId: 'assistant',
    begin: true,
  })
  assert.equal(isRunning(state[conversationId]), true)
  assert.equal(isOutputStreaming(state[conversationId]), true)
  assert.equal(isSettling(state[conversationId]), false)
  assert.equal(canStartNextTurn(state[conversationId]), false)

  state = reduceClientGenerationState(state, conversationId, {
    status: 'running',
    generationId,
    assistantMessageId: 'assistant',
    outputComplete: true,
  })
  assert.equal(isRunning(state[conversationId]), true)
  assert.equal(isOutputStreaming(state[conversationId]), false)
  assert.equal(isSettling(state[conversationId]), true)
  assert.equal(canStartNextTurn(state[conversationId]), true)

  // A later ordinary running patch must not resurrect the stop button.
  state = reduceClientGenerationState(state, conversationId, {
    status: 'running',
    generationId,
    assistantMessageId: 'assistant',
  })
  assert.equal(isOutputStreaming(state[conversationId]), false)
  assert.equal(isSettling(state[conversationId]), true)

  // A real retry explicitly re-opens the streaming phase.
  state = reduceClientGenerationState(state, conversationId, {
    status: 'running',
    generationId,
    assistantMessageId: 'assistant',
    outputComplete: false,
  })
  assert.equal(isOutputStreaming(state[conversationId]), true)

  state = reduceClientGenerationState(state, conversationId, {
    status: 'completed',
    generationId,
    assistantMessageId: 'assistant',
    authoritativeTerminal: true,
  })
  assert.equal(isRunning(state[conversationId]), false)
  assert.equal(isOutputStreaming(state[conversationId]), false)
  assert.equal(isSettling(state[conversationId]), false)
})
