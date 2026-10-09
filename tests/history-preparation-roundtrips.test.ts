import assert from 'node:assert/strict'
import test from 'node:test'
import { loadBoundedCollection, CONTEXT_PAGE_SIZE } from '../lib/chat/authoritative-context-memory'
import { createHistoryReadScope } from '../lib/llm/active-retrieval-reads'
import type { SupabaseServer } from '../lib/api/guard'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('bounded memory preparation retains all 200 rows with one database read', async () => {
  assert.equal(CONTEXT_PAGE_SIZE, 200)
  for (const count of [0, 1, 31, 32, 33, 48, 64, 199, 200, 201]) {
    const rows = Array.from({ length: count }, (_, index) => ({ id: index, content: `memory ${index}` }))
    let reads = 0
    const actual = await loadBoundedCollection({ maxRows: 200, fetchPage: async (from, to) => {
      reads++
      return { data: rows.slice(from, to + 1), error: null }
    }, map: row => row, unavailableMessage: 'unavailable' })
    assert.deepEqual(actual, rows.slice(0, 200))
    assert.equal(reads, 1)
  }
})

test('one-page preparation retains the existing context byte and read-error guards', async () => {
  await assert.rejects(loadBoundedCollection({ maxRows: 200,
    fetchPage: async () => ({ data: [{ content: 'x'.repeat(300_000) }], error: null }),
    map: row => row, unavailableMessage: 'unavailable' }), /处理上限/)
  await assert.rejects(loadBoundedCollection({ maxRows: 200,
    fetchPage: async () => ({ data: null, error: new Error('database') }),
    map: row => row, unavailableMessage: 'unavailable' }), /unavailable/)
})

test('concurrent identical reads coalesce, settled values are immediately discarded', async () => {
  const pending = deferred<{ data: { id: string }; error: null }>()
  let reads = 0
  const query = { select() { return query }, eq() { return query }, maybeSingle() { reads++; return pending.promise } }
  const scope = createHistoryReadScope({ from: () => query } as unknown as SupabaseServer, 'alice')
  const first = scope.conversation('old')
  const duplicate = scope.conversation('old')
  assert.equal(first, duplicate)
  await Promise.resolve()
  assert.equal(reads, 1)
  pending.resolve({ data: { id: 'old' }, error: null })
  await Promise.all([first, duplicate])
  assert.notEqual(scope.conversation('old'), first)
  await Promise.resolve()
  assert.equal(reads, 2)
})

test('separate accounts and separate requests cannot share their pending reads', async () => {
  const pending = deferred<{ data: null; error: null }>()
  const users: string[] = []
  const client = { from() {
    const query = { select() { return query }, eq(field: string, value: string) {
      if (field === 'user_id') users.push(value)
      return query
    }, maybeSingle() { return pending.promise } }
    return query
  } } as unknown as SupabaseServer
  const alice = createHistoryReadScope(client, 'alice')
  const bob = createHistoryReadScope(client, 'bob')
  const secondAliceRequest = createHistoryReadScope(client, 'alice')
  const first = alice.conversation('old')
  const second = bob.conversation('old')
  const third = secondAliceRequest.conversation('old')
  assert.notEqual(first, second)
  assert.notEqual(first, third)
  await Promise.resolve()
  assert.deepEqual(users, ['alice', 'bob', 'alice'])
  pending.resolve({ data: null, error: null })
  await Promise.all([first, second, third])
})

test('a failed read is removed and a later read can retry successfully', async () => {
  let reads = 0
  const query = { select() { return query }, eq() { return query }, async maybeSingle() {
    if (++reads === 1) throw new Error('temporary')
    return { data: { id: 'old' }, error: null }
  } }
  const scope = createHistoryReadScope({ from: () => query } as unknown as SupabaseServer, 'alice')
  await assert.rejects(scope.conversation('old'), /temporary/)
  assert.deepEqual(await scope.conversation('old'), { data: { id: 'old' }, error: null })
  assert.equal(reads, 2)
})
