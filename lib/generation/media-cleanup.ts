import type { SupabaseClient } from '@supabase/supabase-js'
import { log } from '@/lib/logger'

const CLEANUP_TABLE = 'generated_media_cleanup_jobs'
const GENERATED_MEDIA_BUCKET = 'generated-media'
const MAX_DRAIN_JOBS = 50

export type GeneratedMediaCleanupScope = {
  userId: string
  conversationId: string
  generationId: string
}

export type GeneratedMediaCleanupReason = 'history_delete' | 'orphan_upload'

type CleanupJob = {
  object_key: string
}

function cleanupRows(
  scope: GeneratedMediaCleanupScope,
  objectKeys: readonly string[],
  reason: GeneratedMediaCleanupReason,
) {
  const timestamp = new Date().toISOString()
  return objectKeys.map(objectKey => ({
    object_key: objectKey,
    user_id: scope.userId,
    conversation_id: scope.conversationId,
    generation_id: scope.generationId,
    reason,
    attempts: 0,
    last_error: null,
    updated_at: timestamp,
    completed_at: null,
  }))
}

export async function queueGeneratedMediaCleanup(
  admin: SupabaseClient,
  scope: GeneratedMediaCleanupScope,
  objectKeys: readonly string[],
  reason: GeneratedMediaCleanupReason,
): Promise<void> {
  if (!objectKeys.length) return
  const { error } = await admin.from(CLEANUP_TABLE).upsert(
    cleanupRows(scope, [...new Set(objectKeys)], reason),
    { onConflict: 'object_key' },
  )
  if (error) throw error
}

async function markCompleted(admin: SupabaseClient, objectKeys: readonly string[]): Promise<void> {
  if (!objectKeys.length) return
  const timestamp = new Date().toISOString()
  const { error } = await admin.from(CLEANUP_TABLE)
    .update({ completed_at: timestamp, updated_at: timestamp, last_error: null })
    .in('object_key', [...new Set(objectKeys)])
  if (error) throw error
}

async function markFailed(admin: SupabaseClient, objectKeys: readonly string[]): Promise<void> {
  if (!objectKeys.length) return
  const { error } = await admin.from(CLEANUP_TABLE)
    .update({ updated_at: new Date().toISOString(), last_error: 'storage_cleanup_failed' })
    .in('object_key', [...new Set(objectKeys)])
  if (error) throw error
}

/** Remove jobs already durably queued by the same transaction as history deletion. */
export async function removeQueuedGeneratedMedia(
  admin: SupabaseClient,
  objectKeys: readonly string[],
): Promise<boolean> {
  const uniqueKeys = [...new Set(objectKeys)]
  if (!uniqueKeys.length) return true
  try {
    const { error } = await admin.storage.from(GENERATED_MEDIA_BUCKET).remove(uniqueKeys)
    if (error) throw error
    await markCompleted(admin, uniqueKeys).catch(error => {
      log.warn('media-cleanup', 'storage removed but cleanup receipt was not acknowledged', {
        count: uniqueKeys.length,
        name: error instanceof Error ? error.name : 'unknown',
      })
    })
    return true
  } catch (error) {
    await markFailed(admin, uniqueKeys).catch(() => undefined)
    log.warn('media-cleanup', 'queued storage cleanup remains pending', {
      count: uniqueKeys.length,
      name: error instanceof Error ? error.name : 'unknown',
    })
    return false
  }
}

/** Retry old receipts opportunistically from media and history write paths. */
export async function drainGeneratedMediaCleanup(admin: SupabaseClient): Promise<number> {
  try {
    const { data, error } = await admin.from(CLEANUP_TABLE)
      .select('object_key')
      .is('completed_at', null)
      .order('created_at', { ascending: true })
      .limit(MAX_DRAIN_JOBS)
    if (error || !data?.length) return 0
    const objectKeys = (data as CleanupJob[]).map(job => job.object_key).filter(Boolean)
    return await removeQueuedGeneratedMedia(admin, objectKeys) ? objectKeys.length : 0
  } catch {
    return 0
  }
}
