import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'
import type { SupabaseClient } from '../lib/supabase/types'
import type { AuthCtx } from '../lib/api/guard'
import { createChatGPTPlanHistoryPostHandler } from '../app/api/chat/chatgpt-plan-history/route'
import {
  ChatGPTPlanHistoryInputError,
  persistChatGPTPlanHistoryTurn,
  validateChatGPTPlanHistoryTurn,
} from '../lib/chat/chatgpt-plan-history'

const turn = () => ({
  conversationId: '550e8400-e29b-41d4-a716-446655440000',
  createConversation: true,
  title: 'Plan chat',
  projectId: null,
  userMessage: {
    id: '550e8400-e29b-41d4-a716-446655440001',
    role: 'user',
    content: 'Hello',
    images: ['data:image/png;base64,AA=='],
    createdAt: '2026-10-03T10:00:00.000Z',
  },
  assistantMessage: {
    id: '550e8400-e29b-41d4-a716-446655440002',
    role: 'assistant',
    content: 'Hi',
    images: [],
    createdAt: '2026-10-03T10:00:02.000Z',
  },
})

test('validates a complete ChatGPT plan history turn', () => {
  assert.deepEqual(validateChatGPTPlanHistoryTurn(turn()), { ...turn(), regeneration: null })
})

test('rejects provider credentials at the request root and inside a message', () => {
  assert.throws(
    () => validateChatGPTPlanHistoryTurn({ ...turn(), accessToken: 'must-not-cross-to-MyChat' }),
    ChatGPTPlanHistoryInputError,
  )
  const payload: Record<string, unknown> = turn()
  const userMessage = payload.userMessage as Record<string, unknown>
  payload.userMessage = { ...userMessage, refreshToken: 'must-not-persist' }
  assert.throws(() => validateChatGPTPlanHistoryTurn(payload), ChatGPTPlanHistoryInputError)
})

test('rejects invalid roles, message ids, and oversized image payloads', () => {
  const wrongRole = turn()
  wrongRole.assistantMessage.role = 'user'
  assert.throws(() => validateChatGPTPlanHistoryTurn(wrongRole), ChatGPTPlanHistoryInputError)

  const badID = turn()
  badID.userMessage.id = 'not-a-uuid'
  assert.throws(() => validateChatGPTPlanHistoryTurn(badID), ChatGPTPlanHistoryInputError)

  const oversized = turn()
  oversized.userMessage.images = [`data:image/png;base64,${'a'.repeat(8 * 1024 * 1024)}`]
  assert.throws(() => validateChatGPTPlanHistoryTurn(oversized), ChatGPTPlanHistoryInputError)
})

type Row = Record<string, unknown>
type QueryResult = { data: Row | Row[] | null; error: { code: string } | null }

class MemoryQuery {
  private operation: 'select' | 'insert' | 'update' | 'delete' = 'select'
  private payload: Row | null = null
  private readonly filters: Array<(row: Row) => boolean> = []
  private orderBy: { key: string; ascending: boolean } | null = null
  private take: number | null = null

  constructor(private readonly database: MemoryDatabase, private readonly table: string) {}

  select() { this.operation = 'select'; return this }
  insert(payload: Row) { this.operation = 'insert'; this.payload = payload; return this.execute() }
  update(payload: Row) { this.operation = 'update'; this.payload = payload; return this }
  delete() { this.operation = 'delete'; return this }
  eq(key: string, value: unknown) { this.filters.push(row => row[key] === value); return this }
  gt(key: string, value: number) { this.filters.push(row => typeof row[key] === 'number' && row[key] > value); return this }
  order(key: string, options: { ascending: boolean }) { this.orderBy = { key, ascending: options.ascending }; return this }
  limit(value: number) { this.take = value; return this }
  maybeSingle() { return this.execute(true) }

  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected)
  }

  private async execute(single = false): Promise<QueryResult> {
    const rows = this.database.rows(this.table)
    if (this.operation === 'insert') {
      const payload = this.payload
      if (!payload) throw new Error('Insert payload missing')
      if (rows.some(row => row.id === payload.id)) return { data: null, error: { code: '23505' } }
      if (this.table === 'messages') {
        payload.seq = rows.reduce((max, row) => Math.max(max, Number(row.seq) || 0), 0) + 1
        payload.images = payload.images ?? null
      }
      rows.push({ ...payload })
      return { data: null, error: null }
    }

    const matching = rows.filter(row => this.filters.every(filter => filter(row)))
    if (this.operation === 'update' && this.payload) {
      for (const row of matching) Object.assign(row, this.payload)
      return { data: null, error: null }
    }
    if (this.operation === 'delete') {
      this.database.replaceRows(this.table, rows.filter(row => !matching.includes(row)))
      return { data: null, error: null }
    }

    let selected = [...matching]
    if (this.orderBy) {
      const { key, ascending } = this.orderBy
      selected.sort((left, right) => {
        const difference = Number(left[key]) - Number(right[key])
        return ascending ? difference : -difference
      })
    }
    if (this.take !== null) selected = selected.slice(0, this.take)
    return { data: single ? selected[0] ?? null : selected, error: null }
  }
}

class MemoryDatabase {
  private readonly tables = new Map<string, Row[]>([
    ['conversations', []], ['messages', []], ['projects', []],
  ])

  from(table: string) { return new MemoryQuery(this, table) }
  rows(table: string) {
    const rows = this.tables.get(table)
    if (!rows) throw new Error(`Unexpected table ${table}`)
    return rows
  }
  replaceRows(table: string, rows: Row[]) { this.tables.set(table, rows) }
  get conversations() { return this.rows('conversations') }
  get messages() { return this.rows('messages') }
}

const USER_A = '10000000-0000-4000-8000-000000000001'
const USER_B = '10000000-0000-4000-8000-000000000002'

function testHandler(database: MemoryDatabase) {
  return createChatGPTPlanHistoryPostHandler({
    resolveAuth: async request => {
      const token = request?.headers.get('authorization')
      const userId = token === 'Bearer mychat-session-a' ? USER_A
        : token === 'Bearer mychat-session-b' ? USER_B : null
      return {
        supabase: userId ? database as unknown as NonNullable<AuthCtx['supabase']> : null,
        userId,
        isAnonymous: !userId,
      }
    },
    enforceRequestRateLimit: async () => ({}),
    createAdminClient: () => database as unknown as SupabaseClient,
  })
}

function historyRequest(payload: unknown, token?: string) {
  return new NextRequest('https://mychat.example/api/chat/chatgpt-plan-history', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: token } : {}),
    },
    body: JSON.stringify(payload),
  })
}

test('requires a MyChat session before accessing persistence', async () => {
  const database = new MemoryDatabase()
  const response = await testHandler(database)(historyRequest(turn()))

  assert.equal(response.status, 401)
  assert.equal(database.conversations.length, 0)
  assert.equal(database.messages.length, 0)
})

test('saves a logged-in turn idempotently and blocks cross-account conversation access', async () => {
  const database = new MemoryDatabase()
  const handler = testHandler(database)
  const payload = turn()
  const saved = await handler(historyRequest(payload, 'Bearer mychat-session-a'))
  const repeated = await handler(historyRequest(payload, 'Bearer mychat-session-a'))

  assert.equal(saved.status, 200)
  assert.equal(repeated.status, 200)
  assert.equal(database.conversations.length, 1)
  assert.equal(database.messages.length, 2)
  assert.equal(database.messages[0]?.seq, 1)
  assert.equal(database.messages[1]?.seq, 2)

  const foreignResponse = await handler(historyRequest(payload, 'Bearer mychat-session-b'))
  assert.equal(foreignResponse.status, 404)
  assert.equal(database.conversations.length, 1)
  assert.equal(database.messages.length, 2)
})

test('repeated regeneration replaces only the requested tail and stays idempotent', async () => {
  const database = new MemoryDatabase()
  const first = turn()
  const initial = validateChatGPTPlanHistoryTurn(first)
  assert.equal((await persistChatGPTPlanHistoryTurn(database as unknown as SupabaseClient, USER_A, initial)).kind, 'persisted')

  const regenerated = validateChatGPTPlanHistoryTurn({
    ...turn(),
    createConversation: false,
    userMessage: first.userMessage,
    assistantMessage: {
      ...first.assistantMessage,
      id: '550e8400-e29b-41d4-a716-446655440003',
      content: 'A revised answer',
      createdAt: '2026-10-03T10:00:03.000Z',
    },
    regeneration: {
      operation: 'replace-assistant',
      expectedTailMessageID: first.assistantMessage.id,
      targetAssistantMessageID: first.assistantMessage.id,
    },
  })

  assert.equal((await persistChatGPTPlanHistoryTurn(database as unknown as SupabaseClient, USER_A, regenerated)).kind, 'persisted')
  assert.equal((await persistChatGPTPlanHistoryTurn(database as unknown as SupabaseClient, USER_A, regenerated)).kind, 'persisted')
  assert.deepEqual(database.messages.map(message => message.id), [
    first.userMessage.id,
    '550e8400-e29b-41d4-a716-446655440003',
  ])
})
