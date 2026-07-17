import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadRegenerationCleanupKeys } from '../lib/chat/regeneration-cleanup'

const userId = '91000000-0000-4000-8000-000000000001'
const conversationId = '91000000-0000-4000-8000-000000000002'
const sourceId = '91000000-0000-4000-8000-000000000003'
const tailId = '91000000-0000-4000-8000-000000000004'
const generationId = '91000000-0000-4000-8000-000000000005'
const objectKey = `${userId}/${conversationId}/${generationId}/asset.png`

function fakeClient(results: Array<{ data: unknown; error: unknown }>, filters: string[][] = []): SupabaseClient {
  let call = 0
  return {
    from: () => {
      const result = results[call++] ?? { data: null, error: { code: 'missing_fixture' } }
      const currentFilters: string[] = []
      filters.push(currentFilters)
      const query = {
        select: () => query,
        eq: (field: string, value: unknown) => {
          currentFilters.push(`eq:${field}:${String(value)}`)
          return query
        },
        gt: (field: string, value: unknown) => {
          currentFilters.push(`gt:${field}:${String(value)}`)
          return query
        },
        order: () => query,
        limit: () => query,
        maybeSingle: async () => result,
        then: <TResult1 = unknown, TResult2 = never>(
          fulfilled?: ((value: typeof result) => TResult1 | PromiseLike<TResult1>) | null,
          rejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ) => Promise.resolve(result).then(fulfilled, rejected),
      }
      return query
    },
  } as unknown as SupabaseClient
}

test('regeneration cleanup derives only controlled or exact-origin durable media keys', async () => {
  const filters: string[][] = []
  const client = fakeClient([
    { data: { seq: 7 }, error: null },
    {
      data: [{
        id: tailId,
        conversation_id: conversationId,
        seq: 8,
        images: {
          generated_media: [
            { type: 'image', url: `/api/v1/media/${objectKey}/content` },
            { type: 'image', url: `https://project.supabase.co/storage/v1/object/authenticated/generated-media/${objectKey}` },
            { type: 'image', url: `https://evil.example/storage/v1/object/authenticated/generated-media/${objectKey}` },
          ],
        },
      }],
      error: null,
    },
  ], filters)
  const keys = await loadRegenerationCleanupKeys({
    client,
    userId,
    conversationId,
    sourceUserMessageId: sourceId,
    authority: {
      schemaVersion: 2,
      operation: 'replace-from-user',
      expectedTailMessageId: tailId,
    },
    storageOrigin: 'https://project.supabase.co',
  })
  assert.deepEqual(keys, [objectKey])
  assert.ok(filters[1]?.includes('gt:seq:7'))
})

test('assistant replacement cleanup is scoped to the fenced target message', async () => {
  const filters: string[][] = []
  const client = fakeClient([
    { data: { seq: 7 }, error: null },
    { data: [], error: null },
  ], filters)
  const keys = await loadRegenerationCleanupKeys({
    client,
    userId,
    conversationId,
    sourceUserMessageId: sourceId,
    authority: {
      schemaVersion: 2,
      operation: 'replace-assistant',
      expectedTailMessageId: tailId,
      targetAssistantMessageId: tailId,
    },
    storageOrigin: 'https://project.supabase.co',
  })
  assert.deepEqual(keys, [])
  assert.ok(filters[1]?.includes(`eq:id:${tailId}`))
})

test('regeneration cleanup fails closed on unavailable or oversized branch state', async () => {
  await assert.rejects(loadRegenerationCleanupKeys({
    client: fakeClient([{ data: null, error: { code: 'offline' } }]),
    userId,
    conversationId,
    sourceUserMessageId: sourceId,
    authority: {
      schemaVersion: 2,
      operation: 'replace-from-user',
      expectedTailMessageId: tailId,
    },
    storageOrigin: 'https://project.supabase.co',
  }), /source lookup failed/)

  await assert.rejects(loadRegenerationCleanupKeys({
    client: fakeClient([
      { data: { seq: 7 }, error: null },
      { data: Array.from({ length: 501 }, (_, seq) => ({
        id: `${seq}`, conversation_id: conversationId, images: null, seq,
      })), error: null },
    ]),
    userId,
    conversationId,
    sourceUserMessageId: sourceId,
    authority: {
      schemaVersion: 2,
      operation: 'replace-from-user',
      expectedTailMessageId: tailId,
    },
    storageOrigin: 'https://project.supabase.co',
  }), /branch is too large/)
})
