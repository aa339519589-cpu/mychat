import assert from 'node:assert/strict'
import test from 'node:test'
import { selectGenerationStreamSource } from '../lib/generation/stream-source'
import type { GenerationDatabaseRow } from '../lib/generation/types'

const row: GenerationDatabaseRow = {
  id: '10000000-0000-4000-8000-000000000020',
  user_id: 'user-1',
  conversation_id: '20000000-0000-4000-8000-000000000020',
  assistant_message_id: '30000000-0000-4000-8000-000000000020',
  status: 'running',
  content: '',
  thinking: '',
  sequence: 0,
  error: null,
  media: [],
}

test('a database partition never falls back to an existing local runner', () => {
  const source = selectGenerationStreamSource(
    { kind: 'unavailable', reason: 'database_error' },
    { record: { durability: 'durable' } },
  )
  assert.deepEqual(source, {
    kind: 'coordination_unavailable',
    reason: 'database_error',
  })
})

test('confirmed not-found falls back only for an explicitly ephemeral job', () => {
  assert.deepEqual(
    selectGenerationStreamSource(
      { kind: 'not_found' },
      { record: { durability: 'ephemeral' } },
    ),
    { kind: 'local' },
  )
  assert.deepEqual(
    selectGenerationStreamSource(
      { kind: 'not_found' },
      { record: { durability: 'durable' } },
    ),
    { kind: 'coordination_unavailable', reason: 'durable_row_missing' },
  )
  assert.deepEqual(
    selectGenerationStreamSource({ kind: 'not_found' }, undefined),
    { kind: 'missing' },
  )
})

test('a found database row remains authoritative over local state', () => {
  assert.deepEqual(
    selectGenerationStreamSource(
      { kind: 'found', value: row },
      { record: { durability: 'ephemeral' } },
    ),
    { kind: 'database', row },
  )
})
