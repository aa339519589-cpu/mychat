import type { SupabaseClient } from '@supabase/supabase-js'
import { generatedMediaObjectKey, normalizeGeneratedMedia } from '@/lib/generated-media'
import { log } from '@/lib/logger'
import {
  drainGeneratedMediaCleanup,
  removeQueuedGeneratedMedia,
} from '@/lib/generation/media-cleanup'
import { createAdminClient, resolveAdminConfig } from '@/lib/supabase/admin'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_MESSAGE_DELETE_COUNT = 100
const ASSET = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.(?:png|jpg|webp|gif|mp4|webm|mov)$/

type StoredMessage = {
  id: string
  conversation_id: string
  images: unknown
}

type DeletionResult =
  | { kind: 'deleted'; messageIds: string[]; objectKeys: string[]; cleanupPending: boolean }
  | { kind: 'not_found' }
  | { kind: 'active_generation' }
  | { kind: 'unavailable' }

export type HistoryDeletionDependencies = {
  createAdminClient?: () => SupabaseClient | null
  storageOrigin?: () => string | null
}

function storageOriginFromEnvironment(): string | null {
  const config = resolveAdminConfig()
  if (!config) return null
  try {
    return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || config.url).origin
  } catch {
    return null
  }
}

function validObjectKey(key: string, userId: string, conversationId: string): boolean {
  const parts = key.split('/')
  return parts.length === 4
    && parts[0] === userId
    && parts[1] === conversationId
    && UUID.test(parts[2])
    && ASSET.test(parts[3])
}

/** Extract only canonical BFF references or our exact legacy Storage origin. */
export function generatedMediaObjectKeys(
  messages: readonly StoredMessage[],
  userId: string,
  storageOrigin: string,
): string[] {
  const keys = new Set<string>()
  for (const message of messages) {
    const imageObject = message.images && typeof message.images === 'object' && !Array.isArray(message.images)
      ? message.images as Record<string, unknown>
      : null
    const storedMedia = Array.isArray(imageObject?.generated_media) ? imageObject.generated_media : []
    for (const stored of storedMedia) {
      const media = normalizeGeneratedMedia(stored)
      const storedUrl = stored && typeof stored === 'object' && !Array.isArray(stored)
        ? (stored as { url?: unknown }).url
        : null
      if (!media || typeof storedUrl !== 'string') continue
      try {
        const controlled = storedUrl.startsWith('/api/v1/media/')
        if (!controlled && new URL(storedUrl).origin !== storageOrigin) continue
        const key = generatedMediaObjectKey(storedUrl)
        if (!key) continue
        if (validObjectKey(key, userId, message.conversation_id)) keys.add(key)
      } catch {
        // Invalid or non-storage media is intentionally outside this cleanup scope.
      }
    }
  }
  return [...keys]
}

function adminClient(dependencies: HistoryDeletionDependencies): SupabaseClient | null {
  try {
    return (dependencies.createAdminClient ?? createAdminClient)()
  } catch {
    return null
  }
}

function isActiveDeleteError(error: unknown): boolean {
  const value = error as { code?: unknown; message?: unknown } | null
  return value?.code === '55000'
    || (typeof value?.message === 'string' && value.message.includes('active generation'))
}

async function hasActiveGeneration(
  admin: SupabaseClient,
  userId: string,
  options: { messageIds?: string[]; conversationId?: string; conversationIds?: string[] },
): Promise<'active' | 'clear' | 'unavailable'> {
  let query = admin.from('chat_generations').select('id').eq('user_id', userId).in('status', ['queued', 'running']).limit(1)
  if (options.messageIds) query = query.in('assistant_message_id', options.messageIds)
  if (options.conversationId) query = query.eq('conversation_id', options.conversationId)
  if (options.conversationIds) query = query.in('conversation_id', options.conversationIds)
  const { data, error } = await query
  if (error) return 'unavailable'
  return data?.length ? 'active' : 'clear'
}

async function loadMessages(
  admin: SupabaseClient,
  userId: string,
  options: { messageIds?: string[]; conversationId?: string },
): Promise<{ kind: 'found'; rows: StoredMessage[] } | { kind: 'unavailable' }> {
  let query = admin.from('messages').select('id, conversation_id, images').eq('user_id', userId)
  if (options.messageIds) query = query.in('id', options.messageIds)
  if (options.conversationId) query = query.eq('conversation_id', options.conversationId)
  const { data, error } = await query
  if (error || !data) return { kind: 'unavailable' }
  return { kind: 'found', rows: data as StoredMessage[] }
}

async function deleteMessagesAtomically(
  admin: SupabaseClient,
  userId: string,
  messageIds: string[],
  objectKeys: string[],
): Promise<'deleted' | 'active' | 'unavailable'> {
  const { data, error } = await admin.rpc('delete_messages_with_media_cleanup', {
    p_user_id: userId,
    p_message_ids: messageIds,
    p_object_keys: objectKeys,
  })
  if (!error && Number(data) === messageIds.length) return 'deleted'
  return isActiveDeleteError(error) ? 'active' : 'unavailable'
}

async function deleteConversationAtomically(
  admin: SupabaseClient,
  userId: string,
  conversationId: string,
  objectKeys: string[],
): Promise<'deleted' | 'active' | 'not_found' | 'unavailable'> {
  const { data, error } = await admin.rpc('delete_conversation_with_media_cleanup', {
    p_user_id: userId,
    p_conversation_id: conversationId,
    p_object_keys: objectKeys,
  })
  if (!error && Number(data) === 1) return 'deleted'
  if ((error as { code?: unknown } | null)?.code === 'P0002') return 'not_found'
  return isActiveDeleteError(error) ? 'active' : 'unavailable'
}

export async function deleteMessagesWithGeneratedMedia(
  userId: string,
  ids: unknown,
  dependencies: HistoryDeletionDependencies = {},
): Promise<DeletionResult> {
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_MESSAGE_DELETE_COUNT
    || ids.some(id => typeof id !== 'string' || !UUID.test(id))) return { kind: 'not_found' }
  const messageIds = [...new Set(ids)]
  const admin = adminClient(dependencies)
  const origin = (dependencies.storageOrigin ?? storageOriginFromEnvironment)()
  if (!admin || !origin) return { kind: 'unavailable' }
  const loaded = await loadMessages(admin, userId, { messageIds })
  if (loaded.kind === 'unavailable') return loaded
  if (loaded.rows.length !== messageIds.length) return { kind: 'not_found' }
  const conversationIds = [...new Set(loaded.rows.map(row => row.conversation_id))]
  const active = await hasActiveGeneration(admin, userId, { conversationIds })
  if (active === 'unavailable') return { kind: 'unavailable' }
  if (active === 'active') return { kind: 'active_generation' }
  const objectKeys = generatedMediaObjectKeys(loaded.rows, userId, origin)
  await drainGeneratedMediaCleanup(admin)
  const deleted = await deleteMessagesAtomically(admin, userId, messageIds, objectKeys)
  if (deleted === 'active') return { kind: 'active_generation' }
  if (deleted === 'unavailable') return { kind: 'unavailable' }
  const cleanupPending = !await removeQueuedGeneratedMedia(admin, objectKeys)
  log.info('history', 'messages deleted with durable media cleanup', {
    userId,
    messageCount: messageIds.length,
    objectCount: objectKeys.length,
    cleanupPending,
  })
  return { kind: 'deleted', messageIds, objectKeys, cleanupPending }
}

export async function deleteConversationWithGeneratedMedia(
  userId: string,
  conversationId: string,
  dependencies: HistoryDeletionDependencies = {},
): Promise<DeletionResult> {
  if (!UUID.test(conversationId)) return { kind: 'not_found' }
  const admin = adminClient(dependencies)
  const origin = (dependencies.storageOrigin ?? storageOriginFromEnvironment)()
  if (!admin || !origin) return { kind: 'unavailable' }
  const { data: conversation, error: conversationError } = await admin
    .from('conversations').select('id').eq('id', conversationId).eq('user_id', userId).maybeSingle()
  if (conversationError) return { kind: 'unavailable' }
  if (!conversation) return { kind: 'not_found' }
  const active = await hasActiveGeneration(admin, userId, { conversationId })
  if (active === 'unavailable') return { kind: 'unavailable' }
  if (active === 'active') return { kind: 'active_generation' }
  const loaded = await loadMessages(admin, userId, { conversationId })
  if (loaded.kind === 'unavailable') return loaded
  const objectKeys = generatedMediaObjectKeys(loaded.rows, userId, origin)
  await drainGeneratedMediaCleanup(admin)
  const deleted = await deleteConversationAtomically(admin, userId, conversationId, objectKeys)
  if (deleted === 'not_found') return { kind: 'not_found' }
  if (deleted === 'active') return { kind: 'active_generation' }
  if (deleted === 'unavailable') return { kind: 'unavailable' }
  const cleanupPending = !await removeQueuedGeneratedMedia(admin, objectKeys)
  log.info('history', 'conversation deleted with durable media cleanup', {
    userId,
    conversationId,
    objectCount: objectKeys.length,
    cleanupPending,
  })
  return {
    kind: 'deleted',
    messageIds: loaded.rows.map(row => row.id),
    objectKeys,
    cleanupPending,
  }
}
