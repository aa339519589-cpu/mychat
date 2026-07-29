import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { enqueueChatJob, type EnqueueChatJobInput } from '../lib/chat/job-command'
import { JobRuntimeError } from '../lib/jobs/errors'
import type { JobRecord } from '../lib/jobs/contracts'
import type { JobPayloadReference } from '../lib/jobs/payload-storage'

const userId = '88000000-0000-4000-8000-000000000001'
const generationId = '88000000-0000-4000-8000-000000000002'
const conversationId = '88000000-0000-4000-8000-000000000003'
const userMessageId = '88000000-0000-4000-8000-000000000004'
const assistantMessageId = '88000000-0000-4000-8000-000000000005'
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
      conversationId,
      userMessageId,
      assistantMessageId,
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

function directTurn(createConversation: boolean): EnqueueChatJobInput {
  const input = command()
  input.body.messages = [{
    id: userMessageId,
    role: 'user',
    content: 'hello from iPhone',
    images: ['https://example.com/image.png'],
    ts: '2026-07-17T00:00:00.000Z',
  }]
  input.body.turn = {
    schemaVersion: 1,
    createConversation,
    title: 'iPhone conversation',
    projectId: null,
  }
  return input
}

function enqueuedJob(subject: Record<string, unknown>): JobRecord {
  const timestamp = '2026-07-17T00:00:00.000Z'
  return {
    id: generationId,
    type: 'chat.generation',
    queue: 'chat',
    principal: { id: userId, authClass: 'registered' },
    subject: subject as JobRecord['subject'],
    inputHash: sha256,
    input: {},
    status: 'queued',
    attempt: 0,
    maxAttempts: 3,
    priority: 0,
    availableAt: timestamp,
    budget: { tokenLimit: 160_000 },
    usage: {
      wallTimeMs: 0,
      rawTokens: 0,
      weightedTokens: 0,
      costMicros: 0,
      sandboxTimeMs: 0,
      toolCalls: 0,
    },
    checkpoint: null,
    result: null,
    error: null,
    lease: null,
    cancelRequestedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    terminalAt: null,
  }
}

function compensationClient(data: unknown, error: unknown = null): SupabaseClient {
  const result = { data, error }
  const query = {
    select: () => query,
    eq: () => query,
    maybeSingle: async () => result,
  }
  return { from: () => query } as unknown as SupabaseClient
}

type DirectClientOptions = {
  owner?: boolean
  conversationError?: { code: string } | null
  userMessageError?: { code: string } | null
  assistantMessageError?: { code: string } | null
}

function directClient(options: DirectClientOptions = {}) {
  const writes: Array<{ table: string; operation: string; value?: unknown }> = []
  let rpcCalls = 0
  const owner = options.owner ?? true

  const client = {
    rpc: async () => {
      rpcCalls += 1
      throw new Error('standard chat admission must not call RPC')
    },
    from: (table: string) => {
      const query: Record<string, unknown> = {
        error: null,
        upsert: async (value: unknown) => {
          writes.push({ table, operation: 'upsert', value })
          if (table === 'conversations' && options.conversationError) {
            return { data: null, error: options.conversationError }
          }
          if (table === 'messages') {
            const role = (value as { role?: string }).role
            if (role === 'user' && options.userMessageError) {
              return { data: null, error: options.userMessageError }
            }
            if (role === 'assistant' && options.assistantMessageError) {
              return { data: null, error: options.assistantMessageError }
            }
          }
          return { data: value, error: null }
        },
        select: () => query,
        update: (value: unknown) => {
          writes.push({ table, operation: 'update', value })
          return query
        },
        eq: () => query,
        maybeSingle: async () => ({
          data: table === 'conversations' && owner ? { id: conversationId } : null,
          error: null,
        }),
      }
      return query
    },
  } as unknown as SupabaseClient

  return { client, writes, rpcCalls: () => rpcCalls }
}

function dependencies(client: SupabaseClient, beforeEnqueue?: () => never) {
  return {
    persistPayload: async () => reference,
    removePayload: async () => undefined,
    createRepository: () => ({
      enqueue: async value => {
        if (beforeEnqueue) beforeEnqueue()
        return { created: true, job: enqueuedJob(value.subject) }
      },
    }),
    createAdminClient: () => client,
    sleep: async () => undefined,
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
  await rejectedEnqueue(compensationClient(null), value => removed.push(value))
  assert.deepEqual(removed, [reference])

  removed.length = 0
  await rejectedEnqueue(compensationClient({
    id: generationId,
    payload: { payloadRef: `${userId}/${generationId}/${'b'.repeat(64)}.json` },
  }), value => removed.push(value))
  assert.deepEqual(removed, [reference])
})

test('failed enqueue preserves a payload referenced by an accepted job', async () => {
  const removed: JobPayloadReference[] = []
  await rejectedEnqueue(compensationClient({
    id: generationId,
    payload: { payloadRef: reference.objectKey },
  }), value => removed.push(value))
  assert.deepEqual(removed, [])
})

test('standard chat turns persist and enqueue directly without the chat RPC', async () => {
  const mock = directClient()
  const result = await enqueueChatJob(directTurn(true), dependencies(mock.client))

  assert.equal(result.created, true)
  assert.equal(result.job.id, generationId)
  assert.equal(mock.rpcCalls(), 0)
  assert.deepEqual(mock.writes.map(value => `${value.table}:${value.operation}`), [
    'conversations:upsert',
    'messages:upsert',
    'messages:upsert',
    'conversations:update',
  ])
  const user = mock.writes[1]?.value as { images?: unknown }
  assert.deepEqual(user.images, {
    refs: ['https://example.com/image.png'],
    image_summary: null,
    generated_media: [],
  })
})

test('existing conversations do not require a create RPC or duplicate conversation write', async () => {
  const mock = directClient()
  const result = await enqueueChatJob(directTurn(false), dependencies(mock.client))

  assert.equal(result.job.status, 'queued')
  assert.equal(mock.rpcCalls(), 0)
  assert.deepEqual(mock.writes.map(value => `${value.table}:${value.operation}`), [
    'messages:upsert',
    'messages:upsert',
    'conversations:update',
  ])
})

test('a stale createConversation flag is idempotent for an existing owned conversation', async () => {
  const mock = directClient({ owner: true })
  const result = await enqueueChatJob(directTurn(true), dependencies(mock.client))

  assert.equal(result.created, true)
  assert.equal(mock.rpcCalls(), 0)
  assert.equal(mock.writes[0]?.table, 'conversations')
})

test('direct admission rejects a conversation not owned by the user', async () => {
  const mock = directClient({ owner: false })
  await assert.rejects(
    enqueueChatJob(directTurn(false), dependencies(mock.client)),
    (error: unknown) => error instanceof JobRuntimeError && error.code === 'JOB_CONFLICT',
  )
})

test('direct admission fails before enqueue when message persistence fails', async () => {
  const mock = directClient({ userMessageError: { code: 'PGRST500' } })
  let enqueued = false
  await assert.rejects(
    enqueueChatJob(directTurn(true), dependencies(mock.client, () => {
      enqueued = true
      throw new Error('must not enqueue')
    })),
    (error: unknown) => error instanceof JobRuntimeError
      && error.code === 'JOB_DEPENDENCY_UNAVAILABLE',
  )
  assert.equal(enqueued, false)
})
