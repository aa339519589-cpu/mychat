import assert from 'node:assert/strict'
import test from 'node:test'
import { createCodeRunProgress } from '../lib/code-agent/runtime'
import { createCodeToolExecutor, buildCodeTools } from '../lib/code-tools'
import type { ToolEvent } from '../lib/code-tools/definitions'
import type { SupabaseClient } from '../lib/supabase/types'

const USER_ID = '74000000-0000-4000-8000-000000000001'
const MEMORY_ID = '74000000-0000-4000-8000-000000000002'

function memoryClient() {
  const mutations: Array<{ operation: string; table: string; value?: unknown; filters: Array<[string, unknown]> }> = []

  class Query implements PromiseLike<{ data: unknown; error: null }> {
    private readonly filters: Array<[string, unknown]> = []

    constructor(private readonly table: string) {}

    select() { return this }
    order() { return this }
    limit() { return this }
    eq(field: string, value: unknown) { this.filters.push([field, value]); return this }
    maybeSingle() { return Promise.resolve({ data: { id: MEMORY_ID }, error: null }) }

    insert(value: unknown) {
      mutations.push({ operation: 'insert', table: this.table, value, filters: [...this.filters] })
      return Promise.resolve({ data: null, error: null })
    }

    update(value: unknown) {
      mutations.push({ operation: 'update', table: this.table, value, filters: this.filters })
      return this
    }

    delete() {
      mutations.push({ operation: 'delete', table: this.table, filters: this.filters })
      return this
    }

    then<TResult1 = { data: unknown; error: null }, TResult2 = never>(
      onfulfilled?: ((value: { data: unknown; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      return Promise.resolve({ data: [], error: null }).then(onfulfilled, onrejected)
    }
  }

  const client = {
    from(table: string) { return new Query(table) },
  } as unknown as SupabaseClient
  return { client, mutations }
}

function executor(options: {
  client: SupabaseClient
  events: ToolEvent[]
  memoryEnabled: boolean
  sensitiveMemoryEnabled: boolean
}) {
  const progress = createCodeRunProgress(() => false)
  return createCodeToolExecutor({
    repo: 'owner/repo',
    login: 'architect',
    token: 'test-token',
    defaultBranch: 'main',
    repoIsPrivate: false,
    supabase: options.client,
    userId: USER_ID,
    wsReady: true,
    wsTaskId: 'unused-task',
    wsUserId: USER_ID,
    tavilyApiKey: '',
    emit: event => options.events.push(event as ToolEvent),
    state: progress.toolState,
    canExecute: false,
    memoryEnabled: options.memoryEnabled,
    sensitiveMemoryEnabled: options.sensitiveMemoryEnabled,
  })
}

test('Code exposes shared account Memory tools only while the account Memory switch is on', () => {
  const names = (enabled: boolean) => buildCodeTools({
    isWorkspace: false,
    executePermission: '',
    canExecute: false,
    memoryEnabled: enabled,
  }).map(tool => tool.function.name)

  for (const name of ['remember', 'update_memory', 'forget']) assert.ok(names(true).includes(name))
  for (const name of ['remember', 'update_memory', 'forget']) assert.ok(!names(false).includes(name))
  assert.ok(names(false).includes('code_remember'), 'repository Memory remains separate')
})

test('Code account Memory uses the shared user-scoped tools and emits visible mutation events', async () => {
  const store = memoryClient()
  const events: ToolEvent[] = []
  const execute = executor({
    client: store.client, events, memoryEnabled: true, sensitiveMemoryEnabled: false,
  })

  assert.equal(await execute('remember', { content: 'Prefer concise code reviews', topic: 'Preferences' }), '操作成功')
  const inserted = store.mutations.find(item => item.operation === 'insert')
  assert.equal(inserted?.table, 'memories')
  assert.equal((inserted?.value as { user_id: string }).user_id, USER_ID)
  assert.equal((inserted?.value as { topic: string }).topic, 'Preferences')
  const createdEvent = events.at(-1)
  assert.ok(createdEvent && 'memory' in createdEvent)
  assert.equal(createdEvent.memory.action, 'create')
  assert.equal(createdEvent.memory.id, (inserted?.value as { id: string }).id)
  assert.equal(createdEvent.memory.topic, 'Preferences')
  assert.equal(createdEvent.memory.ok, true)
  assert.match(createdEvent.memory.timestamp ?? '', /^\d{4}-\d\d-\d\dT/)

  await execute('update_memory', { id: MEMORY_ID, content: 'Prefer concise code reviews and small diffs' })
  await execute('forget', { id: MEMORY_ID })
  assert.ok(store.mutations.some(item => item.operation === 'update' && item.filters.some(([key, value]) => key === 'user_id' && value === USER_ID)))
  assert.ok(store.mutations.some(item => item.operation === 'delete' && item.filters.some(([key, value]) => key === 'user_id' && value === USER_ID)))
  assert.deepEqual(events.slice(-2).map(event => 'memory' in event ? event.memory.action : ''), ['update', 'delete'])
})

test('Code Memory never writes sensitive content without explicit account consent', async () => {
  const store = memoryClient()
  const events: ToolEvent[] = []
  const execute = executor({
    client: store.client, events, memoryEnabled: true, sensitiveMemoryEnabled: false,
  })

  assert.match(await execute('remember', { content: 'My diagnosis is diabetes' }), /敏感记忆/)
  assert.equal(store.mutations.some(item => item.operation === 'insert'), false)
  const deniedEvent = events[0]
  assert.ok(deniedEvent && 'memory' in deniedEvent)
  assert.equal(deniedEvent.memory.reason, 'sensitive_consent_required')

  const disabledEvents: ToolEvent[] = []
  const disabledExecute = executor({
    client: store.client, events: disabledEvents, memoryEnabled: false, sensitiveMemoryEnabled: false,
  })
  assert.equal(await disabledExecute('remember', { content: 'Prefer concise code reviews' }), '未知工具。')
  assert.deepEqual(disabledEvents, [])
})
