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

function enqueuedJob(subject: Record<string, unknown>) {
  const timestamp = '2026-07-17T00:00:00.000Z'
  return {
    enqueued: true,
    replayed: false,
    job: {
      id: generationId,
      type: 'chat.generation',
      queue: 'chat',
      principalId: userId,
      authClass: 'registered',
      subject,
      inputHash: sha256,
      payload: {},
      budget: { tokenLimit: 160_000 },
      status: 'queued',
      attempt: 0,
      maxAttempts: 3,
      priority: 0,
      availableAt: timestamp,
      leaseOwner: null,
      leaseVersion: 0,
      leaseExpiresAt: null,
      cancelRequestedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      terminalAt: null,
    },
  }
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

test('server-authoritative turns atomically persist messages and enqueue without the generic repository', async () => {
  const input = command()
  input.body.messages = [{
    id: input.body.userMessageId,
    role: 'user',
    content: 'hello',
    images: ['https://example.com/image.png'],
    ts: '2026-07-17T00:00:00.000Z',
  }]
  input.body.turn = {
    schemaVersion: 1,
    createConversation: true,
    title: '未命名的篇章',
    projectId: null,
  }
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args })
      return {
        data: enqueuedJob({
          conversationId: input.body.conversationId,
          userMessageId: input.body.userMessageId,
          assistantMessageId: input.body.assistantMessageId,
        }),
        error: null,
      }
    },
  } as unknown as SupabaseClient
  const result = await enqueueChatJob(input, {
    persistPayload: async () => reference,
    removePayload: async () => undefined,
    createRepository: () => ({
      enqueue: async () => { throw new Error('generic enqueue must not run') },
    }),
    createAdminClient: () => client,
  })
  assert.equal(result.created, true)
  assert.equal(result.job.id, generationId)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.name, 'enqueue_chat_turn_v1')
  assert.equal(calls[0]?.args.input_create_conversation, true)
  assert.equal(calls[0]?.args.input_user_content, 'hello')
  assert.deepEqual(calls[0]?.args.input_user_images, {
    refs: ['https://example.com/image.png'],
    image_summary: null,
    generated_media: [],
  })
  assert.deepEqual(calls[0]?.args.input_budget, {
    wallTimeMs: 600_000,
    tokenLimit: 160_000,
    toolCallLimit: 64,
  })
})

test('server-authoritative turns survive transient control-plane startup failures', async () => {
  const input = command()
  input.body.messages = [{
    id: input.body.userMessageId,
    role: 'user',
    content: 'hello after deploy',
  }]
  input.body.turn = {
    schemaVersion: 1,
    createConversation: true,
    title: '未命名的篇章',
    projectId: null,
  }
  let attempts = 0
  let payloadWrites = 0
  const delays: number[] = []
  const client = {
    rpc: async () => {
      attempts += 1
      if (attempts === 1) throw new TypeError('fetch failed while instance warms')
      if (attempts === 2) return { data: null, error: { code: 'PGRST000' } }
      return {
        data: {
          enqueued: true,
          replayed: false,
          job: { id: generationId, status: 'queued' },
        },
        error: null,
      }
    },
  } as unknown as SupabaseClient

  const result = await enqueueChatJob(input, {
    persistPayload: async () => {
      payloadWrites += 1
      return reference
    },
    removePayload: async () => undefined,
    createRepository: () => ({
      enqueue: async () => { throw new Error('generic enqueue must not run') },
    }),
    createAdminClient: () => client,
    sleep: async milliseconds => { delays.push(milliseconds) },
  })

  assert.equal(result.created, true)
  assert.equal(result.job.id, generationId)
  assert.equal(result.job.status, 'queued')
  assert.equal(attempts, 3)
  assert.equal(payloadWrites, 1)
  assert.deepEqual(delays, [250, 500])
})

test('server-authoritative regeneration uses the fenced RPC and durable cleanup receipts', async () => {
  const input = command()
  input.body.messages = [{
    id: input.body.userMessageId,
    role: 'user',
    content: 'edited authority',
  }]
  input.body.turn = {
    schemaVersion: 2,
    operation: 'replace-from-user',
    expectedTailMessageId: '88000000-0000-4000-8000-000000000006',
  }
  const cleanupKey = `${userId}/${input.body.conversationId}/${'88000000-0000-4000-8000-000000000007'}/asset.png`
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args })
      return {
        data: enqueuedJob({
          conversationId: input.body.conversationId,
          userMessageId: input.body.userMessageId,
          assistantMessageId: input.body.assistantMessageId,
          regenerationOperation: 'replace-from-user',
          replacedTailMessageId: input.body.turn?.schemaVersion === 2
            ? input.body.turn.expectedTailMessageId
            : null,
        }),
        error: null,
      }
    },
  } as unknown as SupabaseClient
  const cleanupInputs: Record<string, unknown>[] = []
  const result = await enqueueChatJob(input, {
    persistPayload: async () => reference,
    removePayload: async () => undefined,
    createRepository: () => ({
      enqueue: async () => { throw new Error('generic enqueue must not run') },
    }),
    createAdminClient: () => client,
    loadRegenerationCleanupKeys: async value => {
      cleanupInputs.push(value as unknown as Record<string, unknown>)
      return [cleanupKey]
    },
  })
  assert.equal(result.created, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.name, 'enqueue_chat_regeneration_v1')
  assert.equal(calls[0]?.args.input_operation, 'replace-from-user')
  assert.equal(calls[0]?.args.input_user_content, 'edited authority')
  assert.equal(calls[0]?.args.input_target_assistant_message_id, null)
  assert.equal(calls[0]?.args.input_expected_tail_message_id,
    '88000000-0000-4000-8000-000000000006')
  assert.deepEqual(calls[0]?.args.input_cleanup_object_keys, [cleanupKey])
  assert.equal(cleanupInputs[0]?.conversationId, input.body.conversationId)
  assert.deepEqual(cleanupInputs[0]?.authority, input.body.turn)
})
