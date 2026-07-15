import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { enqueueChatJob, type EnqueueChatJobInput } from '../lib/chat/job-command'
import type { JobPayloadReference } from '../lib/jobs/payload-storage'

const userId = '88000000-0000-4000-8000-000000000001'
const generationId = '88000000-0000-4000-8000-000000000002'
const sha256 = 'a'.repeat(64)
const reference: JobPayloadReference = {
  bucket: 'job-payloads',
  objectKey: `${userId}/${generationId}/${sha256}.json`,
  sha256,
  bytes: 128,
  contentType: 'application/json',
}

function command(): EnqueueChatJobInput {
  return {
    body: {
      messages: [{ role: 'user', content: 'hello' }],
      conversationId: '88000000-0000-4000-8000-000000000003',
      userMessageId: '88000000-0000-4000-8000-000000000004',
      assistantMessageId: '88000000-0000-4000-8000-000000000005',
      generationId,
    },
    userId,
    isAnonymous: false,
    usingBalance: false,
    searchMode: 'off',
    outputKind: 'chat',
    requestId: 'request-1',
  }
}

function adminResult(data: unknown, error: unknown = null): SupabaseClient {
  const result = { data, error }
  const query = {
    select: () => query,
    eq: () => query,
    maybeSingle: async () => result,
  }
  return { from: () => query } as unknown as SupabaseClient
}

async function rejectedEnqueue(
  accepted: SupabaseClient | null,
  remove: (value: JobPayloadReference) => void,
): Promise<void> {
  await assert.rejects(enqueueChatJob(command(), {
    persistPayload: async () => reference,
    removePayload: async value => { remove(value) },
    createRepository: () => ({
      enqueue: async () => { throw new Error('job_idempotency_conflict') },
    }),
    createAdminClient: () => accepted,
  }), /job_idempotency_conflict/)
}

test('failed enqueue removes a payload proven to be unreferenced', async () => {
  const removed: JobPayloadReference[] = []
  await rejectedEnqueue(adminResult(null), value => removed.push(value))
  assert.deepEqual(removed, [reference])

  removed.length = 0
  await rejectedEnqueue(adminResult({
    id: generationId,
    payload: { payloadRef: `${userId}/${generationId}/${'b'.repeat(64)}.json` },
  }), value => removed.push(value))
  assert.deepEqual(removed, [reference])
})

test('failed enqueue preserves a payload referenced by an accepted job', async () => {
  const removed: JobPayloadReference[] = []
  await rejectedEnqueue(adminResult({
    id: generationId,
    payload: { payloadRef: reference.objectKey },
  }), value => removed.push(value))
  assert.deepEqual(removed, [])
})

test('ambiguous compensation preserves the payload for the asynchronous janitor', async () => {
  const removed: JobPayloadReference[] = []
  await rejectedEnqueue(adminResult(null, { code: 'database_unavailable' }), value => removed.push(value))
  await rejectedEnqueue(null, value => removed.push(value))
  await rejectedEnqueue(adminResult({ id: generationId }), value => removed.push(value))
  assert.deepEqual(removed, [])
})
