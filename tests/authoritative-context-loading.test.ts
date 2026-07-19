import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  AuthoritativeContextError,
  loadAuthoritativeChatContext,
} from '../lib/chat/authoritative-context'

const userId = '87000000-0000-4000-8000-000000000001'
const conversationId = '87000000-0000-4000-8000-000000000002'
const userMessageId = '87000000-0000-4000-8000-000000000003'

type Result = { data: unknown; error: unknown }
type ContextFixture = {
  conversation?: Result
  userMessage?: Result
  history?: Result
  profile?: Result
  memories?: Result
  project?: Result
  projectFiles?: Result
  projectMemories?: Result
}

type QueryCall = {
  table: string
  selected: string
  filters: Array<[string, unknown]>
  orders: Array<[string, unknown]>
  limit: number | null
  range: [number, number] | null
}

function result(value: unknown): Result {
  return { data: value, error: null }
}

function contextClient(fixture: ContextFixture) {
  const calls: QueryCall[] = []
  const defaults: Required<ContextFixture> = {
    conversation: result({ id: conversationId, project_id: null }),
    userMessage: result({
      id: userMessageId,
      role: 'user',
      conversation_id: conversationId,
      user_id: userId,
      seq: 2,
    }),
    history: result([
      {
        id: userMessageId,
        role: 'user',
        content: 'current',
        content_parts: null,
        media_refs: null,
        images: null,
        created_at: '2026-07-15T00:02:00.000Z',
        seq: 2,
      },
      {
        id: '87000000-0000-4000-8000-000000000004',
        role: 'assistant',
        content: 'previous',
        content_parts: null,
        media_refs: null,
        images: null,
        created_at: '2026-07-15T00:01:00.000Z',
        seq: 1,
      },
    ]),
    profile: result({ memory_enabled: true, custom_system_prompt: '' }),
    memories: result([]),
    project: result({ id: 'project', instructions: '' }),
    projectFiles: result([]),
    projectMemories: result([]),
    ...fixture,
  }

  function selectedResult(table: string, selected: string): Result {
    if (table === 'conversations') return defaults.conversation
    if (table === 'messages') {
      return selected.includes('conversation_id, user_id, seq')
        ? defaults.userMessage
        : defaults.history
    }
    if (table === 'profiles') return defaults.profile
    if (table === 'memories') return defaults.memories
    if (table === 'projects') return defaults.project
    if (table === 'project_files') return defaults.projectFiles
    if (table === 'project_memories') return defaults.projectMemories
    return { data: null, error: { code: 'unexpected_table' } }
  }

  const client = {
    from(table: string) {
      const call: QueryCall = {
        table,
        selected: '',
        filters: [],
        orders: [],
        limit: null,
        range: null,
      }
      calls.push(call)
      const query = {
        select(columns: string) {
          call.selected = columns
          return query
        },
        eq(column: string, value: unknown) {
          call.filters.push([column, value])
          return query
        },
        in(column: string, value: unknown) {
          call.filters.push([column, value])
          return query
        },
        lte(column: string, value: unknown) {
          call.filters.push([`${column}<=`, value])
          return query
        },
        order(column: string, options?: unknown) {
          call.orders.push([column, options])
          return query
        },
        maybeSingle() {
          return Promise.resolve(selectedResult(table, call.selected))
        },
        limit(value: number) {
          call.limit = value
          return Promise.resolve(selectedResult(table, call.selected))
        },
        range(from: number, to: number) {
          call.range = [from, to]
          const selected = selectedResult(table, call.selected)
          return Promise.resolve({
            ...selected,
            data: Array.isArray(selected.data) ? selected.data.slice(from, to + 1) : selected.data,
          })
        },
      }
      return query
    },
  } as unknown as SupabaseClient

  return { calls, client }
}

async function load(client: SupabaseClient) {
  return loadAuthoritativeChatContext({
    client,
    userId,
    conversationId,
    userMessageId,
  })
}

function hasCode(error: unknown, code: AuthoritativeContextError['code']): boolean {
  return error instanceof AuthoritativeContextError && error.code === code
}

test('global authoritative context scopes history and normalizes durable media and memories', async () => {
  const current = {
    id: userMessageId,
    role: 'user',
    content: 'legacy current',
    content_parts: [{ type: 'text', text: 'structured current' }],
    media_refs: ['storage/current.png', 42],
    images: { refs: ['legacy.png'], image_summary: 'diagram' },
    created_at: '2026-07-15T00:03:00.000Z',
    seq: 7,
  }
  const prior = {
    id: '87000000-0000-4000-8000-000000000004',
    role: 'assistant',
    content: 'prior answer',
    content_parts: null,
    media_refs: [],
    images: ['legacy-a.png', 8],
    created_at: '2026-07-15T00:02:00.000Z',
    seq: 6,
  }
  const database = contextClient({
    userMessage: result({ id: userMessageId, role: 'user', seq: 7 }),
    history: result([current, prior]),
    memories: result([
      {
        id: 'memory-1',
        content: 'remember this',
        created_at: '2026-07-14T00:00:00.000Z',
        updated_at: '2026-07-15T00:00:00.000Z',
      },
      { id: 2, content: 9, created_at: '2026-07-13T00:00:00.000Z', updated_at: null },
    ]),
  })
  const loaded = await load(database.client)

  assert.deepEqual(loaded.messages.map(message => message.id), [prior.id, current.id])
  assert.deepEqual(loaded.messages[1], {
    id: userMessageId,
    role: 'user',
    content: [{ type: 'text', text: 'structured current' }],
    images: ['storage/current.png'],
    imageSummary: 'diagram',
    ts: '2026-07-15T00:03:00.000Z',
  })
  assert.deepEqual(loaded.messages[0]?.images, ['legacy-a.png'])
  assert.deepEqual(loaded.memories, [{
    id: 'memory-1',
    content: 'remember this',
    timestamp: '2026-07-15T00:00:00.000Z',
  }, {
    id: '2',
    content: '',
    timestamp: '2026-07-13T00:00:00.000Z',
  }])
  assert.equal(loaded.memoryEnabled, true)
  assert.equal(loaded.project, undefined)

  const historyCall = database.calls.find(call => (
    call.table === 'messages' && call.selected.includes('content_parts')
  ))
  assert.ok(historyCall)
  assert.deepEqual(historyCall.filters, [
    ['conversation_id', conversationId],
    ['user_id', userId],
    ['role', ['user', 'assistant']],
    ['seq<=', 7],
  ])
  assert.equal(historyCall.orders[0]?.[0], 'seq')
  assert.deepEqual(historyCall.range, [0, 31])
})

test('project context replaces global memories and bounds every tenant query', async () => {
  const projectId = '87000000-0000-4000-8000-000000000005'
  const database = contextClient({
    conversation: result({ id: conversationId, project_id: projectId }),
    project: result({ id: projectId, instructions: 'Follow project rules' }),
    projectFiles: result([
      { name: 'README.md', content: 'project docs' },
      { name: 7, content: null },
    ]),
    projectMemories: result([
      { id: 'project-memory', content: 'project fact' },
      { id: 9, content: null },
    ]),
    profile: result({ memory_enabled: true, custom_system_prompt: 'Always use concise bullet points.' }),
  })
  const loaded = await load(database.client)

  assert.deepEqual(loaded.memories, [])
  assert.equal(loaded.memoryEnabled, false)
  assert.deepEqual(loaded.project, {
    id: projectId,
    instructions: 'Follow project rules',
    files: [
      { name: 'README.md', content: 'project docs' },
      { name: '', content: '' },
    ],
    projectMemories: [
      { id: 'project-memory', content: 'project fact' },
      { id: '9', content: '' },
    ],
  })
  assert.equal(database.calls.some(call => call.table === 'memories'), false)
  for (const table of ['projects', 'project_files', 'project_memories']) {
    const call = database.calls.find(candidate => candidate.table === table)
    assert.ok(call)
    assert.ok(call.filters.some(([column, value]) => column === 'user_id' && value === userId))
  }
})

test('legacy sequence fallback orders by creation time and honors disabled memory', async () => {
  const database = contextClient({
    userMessage: result({ id: userMessageId, role: 'user', seq: null }),
    profile: result({ memory_enabled: false }),
    memories: result([{ id: 'hidden', content: 'must not escape' }]),
  })
  const loaded = await load(database.client)
  assert.equal(loaded.memoryEnabled, false)
  assert.deepEqual(loaded.memories, [])
  const historyCall = database.calls.find(call => (
    call.table === 'messages' && call.selected.includes('content_parts')
  ))
  assert.equal(historyCall?.orders[0]?.[0], 'created_at')
  assert.equal(historyCall?.filters.some(([column]) => column === 'seq<='), false)
})

test('conversation and message ownership failures use stable authority errors', async () => {
  await assert.rejects(
    load(contextClient({
      conversation: { data: null, error: { code: 'offline' } },
    }).client),
    error => hasCode(error, 'CONTEXT_UNAVAILABLE'),
  )
  await assert.rejects(
    load(contextClient({ conversation: result(null) }).client),
    error => hasCode(error, 'CONVERSATION_NOT_FOUND'),
  )
  await assert.rejects(
    load(contextClient({ userMessage: result(null) }).client),
    error => hasCode(error, 'USER_MESSAGE_NOT_FOUND'),
  )
  await assert.rejects(
    load(contextClient({ history: { data: null, error: { code: 'offline' } } }).client),
    error => hasCode(error, 'CONTEXT_UNAVAILABLE'),
  )
  await assert.rejects(
    load(contextClient({ history: result([]) }).client),
    error => hasCode(error, 'USER_MESSAGE_NOT_FOUND'),
  )
})

test('project and memory dependencies fail closed while oversized project input is compacted', async () => {
  const projectId = '87000000-0000-4000-8000-000000000005'
  await assert.rejects(
    load(contextClient({
      conversation: result({ id: conversationId, project_id: projectId }),
      projectFiles: { data: null, error: { code: 'offline' } },
    }).client),
    error => hasCode(error, 'CONTEXT_UNAVAILABLE'),
  )
  await assert.rejects(
    load(contextClient({
      profile: { data: null, error: { code: 'offline' } },
    }).client),
    error => hasCode(error, 'CONTEXT_UNAVAILABLE'),
  )
  const compacted = await load(contextClient({
    conversation: result({ id: conversationId, project_id: projectId }),
    project: result({ id: projectId, instructions: 'x'.repeat(1_100_000) }),
  }).client)
  assert.ok(compacted.project)
  assert.ok(compacted.project.instructions.length <= 12_100)
  assert.match(compacted.project.instructions, /内容已截断/)
})

test('history and project collections are fetched in bounded pages and stop at the byte budget', async () => {
  const history = Array.from({ length: 24 }, (_, index) => ({
    id: index === 0 ? userMessageId : `history-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: index === 1 ? 'x'.repeat(600_000) : `message-${index}`,
    content_parts: null,
    media_refs: null,
    images: null,
    created_at: `2026-07-15T00:${String(59 - index).padStart(2, '0')}:00.000Z`,
    seq: 24 - index,
  }))
  const database = contextClient({
    userMessage: result({ id: userMessageId, role: 'user', seq: 24 }),
    history: result(history),
  })
  const loaded = await load(database.client)
  assert.deepEqual(loaded.messages.map(message => message.id), [userMessageId])
  const historyCalls = database.calls.filter(call => (
    call.table === 'messages' && call.selected.includes('content_parts')
  ))
  assert.equal(historyCalls.length, 1)
  assert.deepEqual(historyCalls[0]?.range, [0, 31])

  const projectId = '87000000-0000-4000-8000-000000000005'
  const files = Array.from({ length: 17 }, (_, index) => ({
    name: `file-${index}.txt`,
    content: `content-${index}`,
  }))
  const projectDatabase = contextClient({
    conversation: result({ id: conversationId, project_id: projectId }),
    project: result({ id: projectId, instructions: '' }),
    projectFiles: result(files),
  })
  const projectLoaded = await load(projectDatabase.client)
  assert.equal(projectLoaded.project?.files.length, 8)
  assert.deepEqual(projectDatabase.calls.filter(call => call.table === 'project_files')
    .map(call => call.range), [[0, 7]])
})
