import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '../lib/supabase/types'
import {
  loadSharedUserMemories,
  loadSharedUserMemoryContext,
} from '../lib/memory/shared-context'

type Result = { data: unknown; error: unknown }

function memoryClient(options: {
  preferences?: Record<string, unknown> | null
  profileError?: unknown
  memories?: Array<Record<string, unknown>>
  memoryError?: unknown
}) {
  const tables: string[] = []
  const filters: Array<[string, string, unknown]> = []
  const limits: number[] = []
  class Query implements PromiseLike<Result> {
    constructor(private readonly table: string) {}
    select() { return this }
    eq(column: string, value: unknown) { filters.push([this.table, column, value]); return this }
    order() { return this }
    limit(value: number) { limits.push(value); return this }
    maybeSingle() {
      return Promise.resolve({ data: options.preferences ?? null, error: options.profileError ?? null })
    }
    then<TResult1 = Result, TResult2 = never>(
      onfulfilled?: ((value: Result) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      const rows = (options.memories ?? []).filter(row => filters
        .filter(([table]) => table === this.table)
        .every(([, column, value]) => row[column] === value))
      const value = this.table === 'memories'
        ? { data: rows, error: options.memoryError ?? null }
        : { data: null, error: null }
      return Promise.resolve(value).then(onfulfilled, onrejected)
    }
  }
  const client = {
    from(table: string) { tables.push(table); return new Query(table) },
  } as unknown as SupabaseClient
  return { client, tables, filters, limits }
}

test('account Memory off prevents cloud Code from querying or receiving saved memories', async () => {
  const mock = memoryClient({
    preferences: { memory_enabled: false, sensitive_memory_enabled: true },
    memories: [{ id: 'm1', content: 'private detail', topic: 'Personal', sensitive: true }],
  })

  const context = await loadSharedUserMemoryContext(mock.client, 'user-1')
  assert.deepEqual(context, { memories: [], memoryEnabled: false, sensitiveMemoryEnabled: true })
  assert.deepEqual(mock.tables, ['profiles'])
})

test('cloud Code receives recent non-sensitive Memory and never loads sensitive rows without consent', async () => {
  const mock = memoryClient({
    preferences: { memory_enabled: true, sensitive_memory_enabled: false },
    memories: [
      { id: 'm1', user_id: 'user-1', content: 'Use concise reviews.', topic: 'Preferences', sensitive: false, enabled: true, updated_at: '2026-10-03T00:00:00Z' },
      { id: 'm2', user_id: 'user-1', content: 'Sensitive fact', topic: 'Health', sensitive: true, enabled: true, updated_at: '2026-10-02T00:00:00Z' },
    ],
  })

  const context = await loadSharedUserMemoryContext(mock.client, 'user-1')
  const memories = context.memories
  assert.equal(context.memoryEnabled, true)
  assert.equal(context.sensitiveMemoryEnabled, false)
  assert.deepEqual(memories, [{
    id: 'm1', content: 'Use concise reviews.', topic: 'Preferences', timestamp: '2026-10-03T00:00:00Z',
  }])
  assert.equal(memories.some(memory => memory.content === 'Sensitive fact'), false)
  assert.ok(mock.filters.some(([table, column, value]) => table === 'memories' && column === 'sensitive' && value === false))
  assert.deepEqual(mock.limits, [40])
})

test('cloud Code includes sensitive Memory only when the profile explicitly opts in', async () => {
  const mock = memoryClient({
    preferences: { memory_enabled: true, sensitive_memory_enabled: true },
    memories: [{ id: 'm1', user_id: 'user-1', content: 'Sensitive fact', topic: 'Health', sensitive: true, enabled: true }],
  })

  const context = await loadSharedUserMemoryContext(mock.client, 'user-1')
  const memories = context.memories
  assert.equal(context.memoryEnabled, true)
  assert.equal(context.sensitiveMemoryEnabled, true)
  assert.equal(memories.length, 1)
  assert.equal(memories[0].sensitive, true)
  assert.ok(!mock.filters.some(([table, column]) => table === 'memories' && column === 'sensitive'))
})

test('preference or memory query errors fail closed without leaking saved content', async () => {
  const preferenceFailure = memoryClient({
    profileError: new Error('unavailable'),
    memories: [{ id: 'm1', content: 'private detail', topic: 'General' }],
  })
  const memoryFailure = memoryClient({
    preferences: { memory_enabled: true, sensitive_memory_enabled: false },
    memoryError: new Error('unavailable'),
  })

  assert.deepEqual(await loadSharedUserMemoryContext(preferenceFailure.client, 'user-1'), {
    memories: [], memoryEnabled: false, sensitiveMemoryEnabled: false,
  })
  assert.deepEqual(await loadSharedUserMemories(memoryFailure.client, 'user-1'), [])
})
