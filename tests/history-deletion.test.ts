import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  deleteConversationWithGeneratedMedia,
  deleteMessagesWithGeneratedMedia,
  generatedMediaObjectKeys,
} from '../lib/chat/history-deletion'

const userId = '00000000-0000-4000-8000-000000000001'
const conversationId = '10000000-0000-4000-8000-000000000001'
const generationId = '20000000-0000-4000-8000-000000000001'
const origin = 'https://project.supabase.co'

test('history deletion only plans exact same-user generated-media object keys', () => {
  const key = `${userId}/${conversationId}/${generationId}/asset.png`
  const keys = generatedMediaObjectKeys([{
    id: 'message-1',
    conversation_id: conversationId,
    images: {
      generated_media: [
        { type: 'image', url: `${origin}/storage/v1/object/public/generated-media/${key}`, mimeType: 'image/png' },
        { type: 'image', url: `${origin}/storage/v1/object/public/generated-media/${key}`, mimeType: 'image/png' },
        { type: 'image', url: 'https://cdn.example.com/not-ours.png', mimeType: 'image/png' },
        { type: 'image', url: `${origin}/storage/v1/object/public/generated-media/other/${conversationId}/${generationId}/asset.png`, mimeType: 'image/png' },
      ],
    },
  }], userId, origin)
  assert.deepEqual(keys, [key])
})

test('history deletion rejects encoded traversal and non-generated media paths', () => {
  const keys = generatedMediaObjectKeys([{
    id: 'message-2',
    conversation_id: conversationId,
    images: {
      generated_media: [
        { type: 'image', url: `${origin}/storage/v1/object/public/generated-media/${userId}/${conversationId}/${generationId}/%2e%2e%2fasset.png`, mimeType: 'image/png' },
        { type: 'image', url: `${origin}/storage/v1/object/public/other/${userId}/${conversationId}/${generationId}/asset.png`, mimeType: 'image/png' },
      ],
    },
  }], userId, origin)
  assert.deepEqual(keys, [])
})

function mediaMessage(id = '30000000-0000-4000-8000-000000000001') {
  const key = `${userId}/${conversationId}/${generationId}/asset.png`
  return {
    id,
    conversation_id: conversationId,
    images: {
      generated_media: [{
        type: 'image',
        url: `${origin}/storage/v1/object/public/generated-media/${key}`,
        mimeType: 'image/png',
      }],
    },
  }
}

function fakeAdmin(options: {
  messages?: ReturnType<typeof mediaMessage>[]
  active?: boolean
  removeError?: boolean
  rpcError?: boolean
}) {
  const removed: string[][] = []
  const deleted: string[] = []
  const queued: string[][] = []
  const messages = options.messages ?? [mediaMessage()]
  const from = (table: string) => {
    let deleting = false
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: () => builder,
      in: () => builder,
      limit: () => builder,
      delete: () => { deleting = true; return builder },
      maybeSingle: async () => table === 'conversations'
        ? { data: { id: conversationId }, error: null }
        : { data: null, error: null },
      then: (resolve: (value: unknown) => unknown) => {
        if (table === 'chat_generations') return Promise.resolve({ data: options.active ? [{ id: 'active' }] : [], error: null }).then(resolve)
        if (table === 'messages') {
          if (deleting) deleted.push('messages')
          return Promise.resolve({ data: deleting ? null : messages, error: null }).then(resolve)
        }
        if (table === 'conversations') {
          if (deleting) deleted.push('conversations')
          return Promise.resolve({ data: null, error: null }).then(resolve)
        }
        return Promise.resolve({ data: null, error: null }).then(resolve)
      },
    }
    return builder
  }
  return {
    client: {
      from,
      rpc: async (name: string, args: Record<string, unknown>) => {
        if (options.rpcError) return { data: null, error: { code: '08006' } }
        const keys = Array.isArray(args.p_object_keys) ? args.p_object_keys as string[] : []
        queued.push(keys)
        if (name === 'delete_messages_with_media_cleanup') {
          deleted.push('messages')
          return { data: Array.isArray(args.p_message_ids) ? args.p_message_ids.length : 0, error: null }
        }
        if (name === 'delete_conversation_with_media_cleanup') {
          deleted.push('conversations')
          return { data: 1, error: null }
        }
        return { data: null, error: { code: '42883' } }
      },
      storage: { from: () => ({ remove: async (keys: string[]) => {
        removed.push(keys)
        return { error: options.removeError ? { message: 'unavailable' } : null }
      } }) },
    } as unknown as SupabaseClient,
    removed,
    deleted,
    queued,
  }
}

test('message deletion clears validated storage objects before removing database rows', async () => {
  const fake = fakeAdmin({})
  const result = await deleteMessagesWithGeneratedMedia(userId, [mediaMessage().id], {
    createAdminClient: () => fake.client,
    storageOrigin: () => origin,
  })
  assert.equal(result.kind, 'deleted')
  assert.deepEqual(fake.removed, [[`${userId}/${conversationId}/${generationId}/asset.png`]])
  assert.deepEqual(fake.deleted, ['messages'])
  assert.deepEqual(fake.queued, [[`${userId}/${conversationId}/${generationId}/asset.png`]])
})

test('an active generation in the containing conversation blocks message deletion before mutation', async () => {
  const fake = fakeAdmin({ active: true })
  const result = await deleteMessagesWithGeneratedMedia(userId, [mediaMessage().id], {
    createAdminClient: () => fake.client,
    storageOrigin: () => origin,
  })
  assert.deepEqual(result, { kind: 'active_generation' })
  assert.deepEqual(fake.removed, [])
  assert.deepEqual(fake.deleted, [])
})

test('storage cleanup failure leaves a durable receipt after the database delete commits', async () => {
  const fake = fakeAdmin({ removeError: true })
  const result = await deleteConversationWithGeneratedMedia(userId, conversationId, {
    createAdminClient: () => fake.client,
    storageOrigin: () => origin,
  })
  assert.equal(result.kind, 'deleted')
  assert.equal(result.kind === 'deleted' && result.cleanupPending, true)
  assert.equal(fake.removed.length, 1)
  assert.deepEqual(fake.deleted, ['conversations'])
  assert.deepEqual(fake.queued, [[`${userId}/${conversationId}/${generationId}/asset.png`]])
})

test('database deletion failure does not remove storage objects', async () => {
  const fake = fakeAdmin({ rpcError: true })
  const result = await deleteMessagesWithGeneratedMedia(userId, [mediaMessage().id], {
    createAdminClient: () => fake.client,
    storageOrigin: () => origin,
  })
  assert.deepEqual(result, { kind: 'unavailable' })
  assert.deepEqual(fake.removed, [])
  assert.deepEqual(fake.deleted, [])
})
