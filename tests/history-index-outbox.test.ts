import assert from 'node:assert/strict'
import test from 'node:test'
import { consumeHistoryIndexOutbox } from '../lib/jobs/history-index-outbox'
import type { SupabaseClient } from '../lib/supabase/types'
import type { JobOutboxMessage } from '../lib/jobs/outbox-contracts'

const principalId = '11000000-0000-4000-8000-000000000001'
const conversationId = '22000000-0000-4000-8000-000000000001'
const sourceJob = { type: 'chat.generation', status: 'completed', principal_id: principalId, subject: { conversationId } }
const message: JobOutboxMessage = {
  id: '33000000-0000-4000-8000-000000000001', jobId: '44000000-0000-4000-8000-000000000001',
  principalId, topic: 'history.index', payload: { conversationId }, attempt: 1, maxAttempts: 10,
  lockVersion: 1, lockExpiresAt: new Date().toISOString(), createdAt: new Date().toISOString(),
}

function clientFor(job: unknown): SupabaseClient {
  const query = { select() { return query }, eq() { return query }, async maybeSingle() { return { data: job, error: null } } }
  return { from: (table: string) => { assert.equal(table, 'jobs'); return query } } as unknown as SupabaseClient
}

test('history index consumer validates completed source authority and renews again before write', async () => {
  const order: string[] = []
  await consumeHistoryIndexOutbox({
    client: clientFor(sourceJob), message, verifyAuthority: async () => { order.push('renew') },
    refresh: async options => {
      assert.equal(options.userId, principalId)
      assert.equal(options.conversationId, conversationId)
      assert.equal(options.strict, true)
      order.push('prepare')
      await options.beforeWrite?.()
      order.push('write')
    },
  })
  assert.deepEqual(order, ['renew', 'prepare', 'renew', 'write'])
})

test('history indexing rejects another principal, conversation or unfinished job', async () => {
  for (const job of [
    { ...sourceJob, principal_id: 'another-principal' },
    { ...sourceJob, subject: { conversationId: 'another-conversation' } },
    { ...sourceJob, status: 'running' },
    { ...sourceJob, type: 'agent.task' },
  ]) {
    await assert.rejects(consumeHistoryIndexOutbox({
      client: clientFor(job), message,
      verifyAuthority: async () => { assert.fail('must reject before authority renewal') },
      refresh: async () => { assert.fail('must not index unowned scope') },
    }), /scope does not match/)
  }
})

test('lost outbox lock prevents index writes', async () => {
  await assert.rejects(consumeHistoryIndexOutbox({
    client: clientFor(sourceJob), message,
    verifyAuthority: async () => { throw new Error('stale lock') },
    refresh: async () => { assert.fail('must not index after lock loss') },
  }), /stale lock/)
})
