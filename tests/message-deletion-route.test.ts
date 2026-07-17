import assert from 'node:assert/strict'
import test from 'node:test'
import type { AuthCtx, RequestRateGate } from '../lib/api/guard'
import {
  handleMessageDeletion,
  type MessageDeletionDependencies,
} from '../lib/api/message-deletion'

const USER_ID = '10000000-0000-4000-8000-000000000001'
const MESSAGE_ID = '20000000-0000-4000-8000-000000000001'
const auth: AuthCtx = { supabase: null, userId: USER_ID, isAnonymous: false }

function dependencies(
  overrides: Partial<MessageDeletionDependencies> = {},
): Partial<MessageDeletionDependencies> {
  return {
    resolveAuth: async () => auth,
    enforceRateLimit: async () => ({}),
    deleteMessages: async (_userId, ids) => ({
      kind: 'deleted',
      messageIds: ids,
      objectKeys: [],
      cleanupPending: false,
    }),
    ...overrides,
  }
}

async function errorCode(response: Response): Promise<string> {
  const body = await response.json() as { error: { code: string } }
  return body.error.code
}

test('message deletion rejects a declared oversized body before JSON parsing', async () => {
  let deleted = false
  const request = new Request('https://mychat.test/api/messages/delete', {
    method: 'POST',
    headers: { 'content-length': String(16 * 1024 + 1) },
    body: JSON.stringify({ ids: [MESSAGE_ID] }),
  })

  const response = await handleMessageDeletion(request, dependencies({
    deleteMessages: async () => {
      deleted = true
      throw new Error('must not delete')
    },
  }))

  assert.equal(response.status, 413)
  assert.equal(await errorCode(response), 'PAYLOAD_TOO_LARGE')
  assert.equal(deleted, false)
})

test('message deletion rejects an oversized chunked body without content-length', async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(12 * 1024).fill(32))
      controller.enqueue(new Uint8Array(5 * 1024).fill(32))
      controller.close()
    },
  })
  const request = new Request('https://mychat.test/api/messages/delete', {
    method: 'POST',
    body,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' })

  const response = await handleMessageDeletion(request, dependencies())

  assert.equal(response.status, 413)
  assert.equal(await errorCode(response), 'PAYLOAD_TOO_LARGE')
})

test('message deletion does not read the body when rate limiting rejects admission', async () => {
  let bodyReads = 0
  const request = new Request('https://mychat.test/api/messages/delete', {
    method: 'POST',
    body: JSON.stringify({ ids: [MESSAGE_ID] }),
    headers: { 'x-request-id': 'message-delete-rate-limit' },
  })
  const limited: RequestRateGate = {
    response: Response.json({ error: 'limited' }, {
      status: 429,
      headers: { 'Retry-After': '17' },
    }),
  }

  const response = await handleMessageDeletion(request, dependencies({
    enforceRateLimit: async () => limited,
    readBody: async () => {
      bodyReads += 1
      return { ids: [MESSAGE_ID] }
    },
  }))

  assert.equal(response.status, 429)
  assert.equal(response.headers.get('retry-after'), '17')
  assert.equal(response.headers.get('x-request-id'), 'message-delete-rate-limit')
  assert.equal(await errorCode(response), 'RATE_LIMITED')
  assert.equal(bodyReads, 0)
})

test('message deletion fails closed when the rate-limit dependency is unavailable', async () => {
  const unavailable: RequestRateGate = {
    response: Response.json({ error: 'unavailable' }, {
      status: 503,
      headers: { 'Retry-After': '3' },
    }),
  }
  const response = await handleMessageDeletion(new Request(
    'https://mychat.test/api/messages/delete',
    { method: 'POST', body: JSON.stringify({ ids: [MESSAGE_ID] }) },
  ), dependencies({ enforceRateLimit: async () => unavailable }))

  assert.equal(response.status, 503)
  assert.equal(response.headers.get('retry-after'), '3')
  assert.equal(await errorCode(response), 'DEPENDENCY_UNAVAILABLE')
})

test('message deletion validates ID shape and count at the API boundary', async () => {
  let deleteCalls = 0
  const invalidBodies = [
    {},
    { ids: [] },
    { ids: ['not-a-uuid'] },
    { ids: Array.from({ length: 101 }, () => MESSAGE_ID) },
  ]

  for (const body of invalidBodies) {
    const response = await handleMessageDeletion(new Request(
      'https://mychat.test/api/messages/delete',
      { method: 'POST', body: JSON.stringify(body) },
    ), dependencies({
      deleteMessages: async () => {
        deleteCalls += 1
        throw new Error('must not delete')
      },
    }))
    assert.equal(response.status, 400)
    assert.equal(await errorCode(response), 'INVALID_REQUEST')
  }
  assert.equal(deleteCalls, 0)
})

test('message deletion maps authorization and use-case outcomes to v1 errors', async () => {
  const unauthenticated = await handleMessageDeletion(new Request(
    'https://mychat.test/api/messages/delete',
    { method: 'POST', body: '{}' },
  ), dependencies({
    resolveAuth: async () => ({ supabase: null, userId: null, isAnonymous: true }),
  }))
  assert.equal(unauthenticated.status, 401)
  assert.equal(await errorCode(unauthenticated), 'AUTH_REQUIRED')

  const outcomes = [
    { result: { kind: 'active_generation' } as const, status: 409, code: 'CONFLICT' },
    { result: { kind: 'not_found' } as const, status: 404, code: 'NOT_FOUND' },
    { result: { kind: 'unavailable' } as const, status: 503, code: 'DEPENDENCY_UNAVAILABLE' },
  ]
  for (const outcome of outcomes) {
    const response = await handleMessageDeletion(new Request(
      'https://mychat.test/api/messages/delete',
      { method: 'POST', body: JSON.stringify({ ids: [MESSAGE_ID] }) },
    ), dependencies({ deleteMessages: async () => outcome.result }))
    assert.equal(response.status, outcome.status)
    assert.equal(await errorCode(response), outcome.code)
  }
})

test('message deletion returns a no-store success with the deleted count', async () => {
  const request = new Request('https://mychat.test/api/messages/delete', {
    method: 'POST',
    body: JSON.stringify({ ids: [MESSAGE_ID] }),
    headers: { 'x-request-id': 'message-delete-success' },
  })
  const response = await handleMessageDeletion(request, dependencies())

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('x-request-id'), 'message-delete-success')
  assert.deepEqual(await response.json(), {
    ok: true,
    deleted: 1,
    cleanupPending: false,
  })
})
