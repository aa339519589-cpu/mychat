import assert from 'node:assert/strict'
import test from 'node:test'
import type { AuthCtx } from '../lib/api/guard'
import {
  handleMemoryCollection,
  handleMemoryItem,
  type MemoryManagementDependencies,
  type UserMemoryStore,
} from '../lib/api/memory-management'

const USER_ID = '10000000-0000-4000-8000-000000000001'
const OTHER_USER_ID = '10000000-0000-4000-8000-000000000002'
const MEMORY_ID = '20000000-0000-4000-8000-000000000001'
const FIXED_DATE = new Date('2026-10-02T17:00:00.000Z')

type Calls = {
  authRequests: Request[]
  listUserIds: string[]
  createInputs: Array<{ userId: string; content: string }>
  updateInputs: Array<{ userId: string; id: string; content: string; updatedAt: string }>
  deleteInputs: Array<{ userId: string; id: string }>
  deleteAllUserIds: string[]
}

function authenticated(userId: string | null = USER_ID, authUnavailable = false): AuthCtx {
  return {
    supabase: null,
    userId,
    isAnonymous: !userId,
    authUnavailable,
  }
}

function harness(options: {
  userId?: string | null
  authUnavailable?: boolean
  listResult?: { data: Awaited<ReturnType<UserMemoryStore['list']>>['data']; error: Awaited<ReturnType<UserMemoryStore['list']>>['error'] }
  createResult?: { data: Awaited<ReturnType<UserMemoryStore['create']>>['data']; error: Awaited<ReturnType<UserMemoryStore['create']>>['error'] }
  updateResult?: { data: Awaited<ReturnType<UserMemoryStore['update']>>['data']; error: Awaited<ReturnType<UserMemoryStore['update']>>['error'] }
  deleteResult?: { data: Awaited<ReturnType<UserMemoryStore['delete']>>['data']; error: Awaited<ReturnType<UserMemoryStore['delete']>>['error'] }
  deleteAllResult?: { data: Awaited<ReturnType<UserMemoryStore['deleteAll']>>['data']; error: Awaited<ReturnType<UserMemoryStore['deleteAll']>>['error'] }
} = {}) {
  const calls: Calls = {
    authRequests: [],
    listUserIds: [],
    createInputs: [],
    updateInputs: [],
    deleteInputs: [],
    deleteAllUserIds: [],
  }
  const memory = { id: MEMORY_ID, content: 'local test memory', created_at: FIXED_DATE.toISOString(), updated_at: FIXED_DATE.toISOString() }
  const store: UserMemoryStore = {
    list: async userId => {
      calls.listUserIds.push(userId)
      return options.listResult ?? { data: [memory], error: null }
    },
    create: async (userId, content) => {
      calls.createInputs.push({ userId, content })
      return options.createResult ?? { data: { ...memory, content }, error: null }
    },
    update: async (userId, id, content, updatedAt) => {
      calls.updateInputs.push({ userId, id, content, updatedAt })
      return options.updateResult ?? { data: { ...memory, id, content, updated_at: updatedAt }, error: null }
    },
    delete: async (userId, id) => {
      calls.deleteInputs.push({ userId, id })
      return options.deleteResult ?? { data: { id }, error: null }
    },
    deleteAll: async userId => {
      calls.deleteAllUserIds.push(userId)
      return options.deleteAllResult ?? { data: [{ id: MEMORY_ID }], error: null }
    },
  }
  const dependencies: Partial<MemoryManagementDependencies> = {
    resolveAuth: async request => {
      calls.authRequests.push(request)
      return authenticated(options.userId === undefined ? USER_ID : options.userId, options.authUnavailable)
    },
    createStore: () => store,
    now: () => FIXED_DATE,
  }
  return { calls, dependencies }
}

function jsonRequest(method: string, body?: object, headers: Record<string, string> = {}): Request {
  return new Request('https://mychat.test/api/memories', {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
}

test('memory list uses the request-bound identity and returns a no-store collection', async () => {
  const { calls, dependencies } = harness()
  const request = jsonRequest('GET', undefined, { authorization: 'Bearer mobile-session' })
  const response = await handleMemoryCollection(request, dependencies)

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(calls.authRequests[0], request)
  assert.deepEqual(calls.listUserIds, [USER_ID])
  assert.deepEqual(await response.json(), {
    memories: [{
      id: MEMORY_ID,
      content: 'local test memory',
      created_at: FIXED_DATE.toISOString(),
      updated_at: FIXED_DATE.toISOString(),
    }],
  })
})

test('memory creation ignores client-supplied ownership and uses authenticated identity', async () => {
  const { calls, dependencies } = harness()
  const response = await handleMemoryCollection(jsonRequest('POST', {
    user_id: OTHER_USER_ID,
    content: '  remember this  ',
  }), dependencies)

  assert.equal(response.status, 201)
  assert.deepEqual(calls.createInputs, [{ userId: USER_ID, content: 'remember this' }])
  assert.equal((await response.json() as { memory: { content: string } }).memory.content, 'remember this')
})

test('memory update and delete are constrained to both authenticated owner and row id', async () => {
  const { calls, dependencies } = harness()
  const updated = await handleMemoryItem(jsonRequest('PATCH', { content: ' updated ' }), MEMORY_ID, dependencies)
  const deleted = await handleMemoryItem(jsonRequest('DELETE'), MEMORY_ID, dependencies)

  assert.equal(updated.status, 200)
  assert.deepEqual(calls.updateInputs, [{
    userId: USER_ID,
    id: MEMORY_ID,
    content: 'updated',
    updatedAt: FIXED_DATE.toISOString(),
  }])
  assert.equal(deleted.status, 200)
  assert.deepEqual(calls.deleteInputs, [{ userId: USER_ID, id: MEMORY_ID }])
})

test('bulk memory deletion is owner-scoped and reports the verified delete count', async () => {
  const { calls, dependencies } = harness()
  const response = await handleMemoryCollection(jsonRequest('DELETE'), dependencies)

  assert.equal(response.status, 200)
  assert.deepEqual(calls.deleteAllUserIds, [USER_ID])
  assert.deepEqual(await response.json(), { deleted: 1 })
})

test('memory handlers reject unauthenticated and unavailable auth before database access', async () => {
  for (const [options, status] of [
    [{ userId: null }, 401],
    [{ userId: null, authUnavailable: true }, 503],
  ] as const) {
    let storeCreated = false
    const { dependencies } = harness(options)
    const response = await handleMemoryCollection(jsonRequest('GET'), {
      ...dependencies,
      createStore: () => { storeCreated = true; return null },
    })
    assert.equal(response.status, status)
    assert.equal(storeCreated, false)
  }
})

test('memory writes validate ids and content before mutating storage', async () => {
  const { calls, dependencies } = harness()
  const invalidContent = await handleMemoryCollection(jsonRequest('POST', { content: ' \n ' }), dependencies)
  const invalidID = await handleMemoryItem(jsonRequest('DELETE'), 'not-a-uuid', dependencies)

  assert.equal(invalidContent.status, 400)
  assert.equal(invalidID.status, 400)
  assert.deepEqual(calls.createInputs, [])
  assert.deepEqual(calls.deleteInputs, [])
})

test('missing or unowned memory rows fail instead of claiming a successful edit or delete', async () => {
  const missingUpdate = harness({ updateResult: { data: null, error: null } })
  const updateResponse = await handleMemoryItem(jsonRequest('PATCH', { content: 'changed' }), MEMORY_ID, missingUpdate.dependencies)
  const missingDelete = harness({ deleteResult: { data: null, error: null } })
  const deleteResponse = await handleMemoryItem(jsonRequest('DELETE'), MEMORY_ID, missingDelete.dependencies)

  assert.equal(updateResponse.status, 404)
  assert.equal(deleteResponse.status, 404)
})
