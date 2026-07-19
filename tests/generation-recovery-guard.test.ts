import assert from 'node:assert/strict'
import test from 'node:test'
import { hasActiveConversationGeneration } from '../components/literary-chat/generation-api'

const job = {
  id: '92000000-0000-4000-8000-000000000001',
  status: 'running',
  subject: {},
  progress: {},
  result: null,
  errorCode: null,
  eventSequence: 0,
}

test('recovery guard recognizes an accepted non-terminal generation', async () => {
  const active = await hasActiveConversationGeneration('conversation id', async url => {
    assert.equal(url, '/api/v1/conversations/conversation%20id/generation')
    return Response.json({ job, streamUrl: '/events' })
  })
  assert.equal(active, true)
})

test('recovery guard permits a new enqueue after a terminal or unavailable lookup', async () => {
  assert.equal(await hasActiveConversationGeneration('conversation', async () => Response.json({
    job: { ...job, status: 'completed' }, streamUrl: '/events',
  })), false)
  assert.equal(await hasActiveConversationGeneration('conversation', async () => new Response(null, {
    status: 503,
  })), false)
})
