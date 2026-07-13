import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  loadGenerationFromDb,
  loadGenerationStatusFromDb,
  loadLatestGenerationForConversation,
  loadRunningGenerations,
} from '../lib/generation/persist'
import type { GenerationDatabaseRow } from '../lib/generation/types'

function row(id: string, expiresAt: string | null): GenerationDatabaseRow {
  return {
    id,
    user_id: 'user-1',
    conversation_id: 'conversation-1',
    assistant_message_id: 'message-1',
    status: 'running',
    content: 'prefix',
    thinking: '',
    sequence: 2,
    error: null,
    media: [],
    lease_owner: 'runner-1',
    lease_expires_at: expiresAt,
    lease_version: 1,
  }
}

function queryBuilder(single: GenerationDatabaseRow | null, many: GenerationDatabaseRow[]) {
  const builder: Record<string, (...args: unknown[]) => unknown> = {}
  for (const method of ['select', 'eq', 'in', 'order']) {
    builder[method] = () => builder
  }
  builder.maybeSingle = async () => ({ data: single, error: null })
  builder.limit = (count: unknown) => count === 1
    ? builder
    : Promise.resolve({ data: many, error: null })
  return builder
}

function withAdmin(client: unknown, timeoutMs?: number) {
  return {
    createAdminClient: () => client as SupabaseClient,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  }
}

test('resume atomically turns an expired orphan into a durable stale failure', async () => {
  const expired = row('generation-expired', '2000-01-01T00:00:00.000Z')
  let staleRpcCalls = 0
  const client = {
    from: () => queryBuilder(expired, []),
    rpc: async (name: string) => {
      assert.equal(name, 'fail_stale_chat_generation')
      staleRpcCalls += 1
      return {
        data: {
          accepted: true,
          status: 'failed',
          error: 'stale_generation_lease_expired',
          content: 'prefix',
          thinking: '',
          sequence: 3,
          media: [],
        },
        error: null,
      }
    },
  }

  const loaded = await loadGenerationFromDb(expired.id, 'user-1', withAdmin(client))
  assert.equal(staleRpcCalls, 1)
  assert.equal(loaded.kind, 'found')
  if (loaded.kind !== 'found') return
  assert.equal(loaded.value.status, 'failed')
  assert.equal(loaded.value.error, 'stale_generation_lease_expired')
  assert.equal(loaded.value.sequence, 3)
  assert.equal(loaded.value.lease_owner, null)
})

test('running bootstrap removes expired or legacy unleased rows', async () => {
  const expired = row('generation-expired-list', null)
  const live = row('generation-live', new Date(Date.now() + 60_000).toISOString())
  const client = {
    from: () => queryBuilder(null, [expired, live]),
    rpc: async () => ({
      data: {
        accepted: true,
        status: 'failed',
        error: 'stale_generation_lease_expired',
        content: 'prefix',
        thinking: '',
        sequence: 3,
        media: [],
      },
      error: null,
    }),
  }

  const running = await loadRunningGenerations('user-1', 'conversation-1', withAdmin(client))
  assert.equal(running.kind, 'found')
  if (running.kind !== 'found') return
  assert.deepEqual(running.value.map(item => item.id), ['generation-live'])
})

test('generation reads classify timeout as unavailable rather than missing', async () => {
  const builder: Record<string, (...args: unknown[]) => unknown> = {}
  for (const method of ['select', 'eq']) builder[method] = () => builder
  builder.maybeSingle = () => new Promise(() => undefined)
  const client = { from: () => builder }
  const startedAt = Date.now()

  const status = await loadGenerationStatusFromDb('g', 'u', withAdmin(client, 10))
  assert.deepEqual(status, { kind: 'unavailable', reason: 'query_timeout' })
  assert.ok(Date.now() - startedAt < 250)
})

test('generation reads distinguish a confirmed missing row from a database partition', async () => {
  const missing = {
    from: () => queryBuilder(null, []),
  }
  const missingResult = await loadGenerationFromDb('g', 'u', withAdmin(missing))
  assert.deepEqual(missingResult, { kind: 'not_found' })

  const unavailableBuilder = queryBuilder(null, [])
  unavailableBuilder.maybeSingle = async () => ({
    data: null,
    error: { code: 'PGRST000', message: 'connection unavailable' },
  })
  const partitioned = { from: () => unavailableBuilder }
  const partitionResult = await loadGenerationFromDb('g', 'u', withAdmin(partitioned))
  assert.deepEqual(partitionResult, {
    kind: 'unavailable',
    reason: 'database_error',
    errorCode: 'PGRST000',
  })
})

test('an expired row is unavailable when stale settlement cannot be persisted', async () => {
  const expired = row('generation-stale-rpc-down', '2000-01-01T00:00:00.000Z')
  const client = {
    from: () => queryBuilder(expired, []),
    rpc: async () => ({
      data: null,
      error: { code: 'PGRST503', message: 'rpc unavailable' },
    }),
  }

  const loaded = await loadGenerationFromDb(expired.id, 'user-1', withAdmin(client))
  assert.deepEqual(loaded, {
    kind: 'unavailable',
    reason: 'stale_settlement_failed',
    errorCode: 'PGRST503',
  })
})

test('generation reads fail closed without the service-role client', async () => {
  const result = await loadGenerationFromDb('g', 'u', { createAdminClient: () => null })
  assert.deepEqual(result, {
    kind: 'unavailable',
    reason: 'database_error',
    errorCode: 'admin_not_configured',
  })
})

test('latest conversation generation returns and settles an expired terminal snapshot', async () => {
  const expired = row('generation-latest', '2000-01-01T00:00:00.000Z')
  const builder = queryBuilder(expired, [])
  const client = {
    from: () => builder,
    rpc: async () => ({
      data: {
        accepted: true,
        status: 'failed',
        error: 'stale_generation_lease_expired',
        content: 'prefix',
        thinking: '',
        sequence: 3,
        media: [],
      },
      error: null,
    }),
  }
  const latest = await loadLatestGenerationForConversation(
    'user-1',
    'conversation-1',
    withAdmin(client),
  )
  assert.equal(latest.kind, 'found')
  if (latest.kind !== 'found') return
  assert.equal(latest.value.status, 'failed')
  assert.equal(latest.value.error, 'stale_generation_lease_expired')
  assert.deepEqual(latest.value.media, [])
})
