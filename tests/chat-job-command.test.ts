import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { enqueueChatJob, type EnqueueChatJobInput } from '../lib/chat/job-command'
import { JobRuntimeError } from '../lib/jobs/errors'
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
      messages: [{
        id: '88000000-0000-4000-8000-000000000004',
        role: 'user',
        content: 'hello',
      }],
      conversationId: '88000000-0000-4000-8000-000000000003',
      userMessageId: '88000000-0000-4000-8000-000000000004',
      assistantMessageId: '88000000-0000-4000-8000-000000000005',
      generationId,
      turn: {
        schemaVersion: 1,
        createConversation: false,
        title: 'Existing conversation',
        projectId: null,
      },
    },
    userId,
    isAnonymous: false,
    usingBalance: false,
    searchMode: 'off',
    outputKind: 'chat',
    requestId: 'request-1',
  }
}

function externalCommand(): EnqueueChatJobInput {
  const input = command()
  input.body.attachments = [{
    name: 'context.txt',
    dataUrl: 'data:text/plain;base64,aGVsbG8=',
    isPdf: false,
    text: 'hello',
  }]
  return input
}

function adminResult(data: unknown, error: unknown = null): SupabaseClient {
  const result = { data, error }
  const query = {
    select: () => query,
    eq: () => query,
    maybeSingle: async () => result,
  }
  return {
    from: () => query,
    rpc: async () => ({
      data: null,
      error: { code: '23505', message: 'job_idempotency_conflict' },
    }),
  } as unknown as SupabaseClient
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
  await assert.rejects(enqueueChatJob(externalCommand(), {
    persistPayload: async () => reference,
    removePayload: async value => { remove(value) },
    createAdminClient: () => accepted,
  }))
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

test('ordinary text jobs keep their tiny command inline without storage round trips', async () => {
  let uploads = 0
  const acceptedInputs: Record<string, unknown>[] = []
  const input = command()
  const client = {
    rpc: async (_name: string, args: Record<string, unknown>) => {
      acceptedInputs.push(args.input_payload as Record<string, unknown>)
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
    persistPayload: async () => {
      uploads += 1
      return reference
    },
    createAdminClient: () => client,
  })
  assert.equal(result.created, true)
  assert.equal(uploads, 0)
  assert.equal(typeof acceptedInputs[0]?.command, 'object')
  assert.equal(acceptedInputs[0]?.payloadRef, undefined)
  assert.match(String(acceptedInputs[0]?.payloadHash), /^[0-9a-f]{64}$/)
})

function directTurnInput(createConversation: boolean): EnqueueChatJobInput {
  const input = command()
  input.body.messages = [{
    id: input.body.userMessageId,
    role: 'user',
    content: createConversation ? 'first native turn' : 'next native turn',
    images: ['https://example.com/image.png'],
    ts: '2026-07-17T00:00:00.000Z',
  }]
  input.body.turn = {
    schemaVersion: 1,
    createConversation,
    title: 'Native conversation',
    projectId: null,
  }
  return input
}

function directTurnClient(
  input: EnqueueChatJobInput,
  calls: Array<{ name: string; args: Record<string, unknown> }>,
): SupabaseClient {
  return {
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
}

async function runDirectTurn(createConversation: boolean) {
  const input = directTurnInput(createConversation)
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const result = await enqueueChatJob(input, {
    persistPayload: async () => { throw new Error('inline chat must not upload a payload') },
    removePayload: async () => undefined,
    createAdminClient: () => directTurnClient(input, calls),
  })
  return { input, result, calls }
}

test('new native turns use one atomic direct durable admission RPC', async () => {
  const { result, calls } = await runDirectTurn(true)
  assert.equal(result.created, true)
  assert.equal(result.job.id, generationId)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.name, 'admit_chat_turn_v2')
  assert.equal(calls[0]?.args.input_create_conversation, true)
  assert.equal(calls[0]?.args.input_user_content, 'first native turn')
  assert.equal(typeof calls[0]?.args.input_payload, 'object')
})

test('existing native conversations use the same atomic admission RPC', async () => {
  const { result, calls } = await runDirectTurn(false)
  assert.equal(result.created, true)
  assert.equal(result.job.id, generationId)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.name, 'admit_chat_turn_v2')
  assert.equal(calls[0]?.args.input_create_conversation, false)
  assert.equal(calls[0]?.args.input_user_content, 'next native turn')
})

test('native turn exposes the exact PostgreSQL failure', async () => {
  const input = directTurnInput(false)
  const client = {
    rpc: async () => ({
      data: null,
      error: {
        code: '23503',
        message: 'direct_chat_conversation_not_found',
        details: 'conversation_id is not owned by input_user_id',
        hint: 'create the conversation or use its owner',
      },
    }),
  } as unknown as SupabaseClient
  await assert.rejects(enqueueChatJob(input, {
    persistPayload: async () => { throw new Error('inline chat must not upload a payload') },
    removePayload: async () => undefined,
    createAdminClient: () => client,
  }), (error: unknown) => {
    assert.ok(error instanceof JobRuntimeError)
    assert.equal(error.code, 'JOB_CONFLICT')
    assert.match(error.message, /23503.*direct_chat_conversation_not_found/)
    assert.equal(error.details.databaseCode, '23503')
    assert.equal(error.details.databaseDetails, 'conversation_id is not owned by input_user_id')
    assert.equal(error.details.databaseHint, 'create the conversation or use its owner')
    return true
  })
})

test('server-authoritative regeneration still uses the fenced RPC and cleanup receipts', async () => {
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
