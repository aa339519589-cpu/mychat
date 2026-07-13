import type { GeneratedMedia } from '@/lib/generated-media'
import {
  cleanupDurableGeneratedMediaUploads,
  persistDurableGeneratedMediaList,
  type DurableMediaPersistenceBatch,
} from '@/lib/generation/media-storage'
import type { JobExecutionContext } from '../worker'
import { jobAssetUploadLifecycle } from '../assets'
import type { LoadedChatJob } from './chat-input'

export type ChatMediaPersistenceDependencies = {
  persistMediaList: typeof persistDurableGeneratedMediaList
  cleanupMedia: typeof cleanupDurableGeneratedMediaUploads
}

export const CHAT_MEDIA_PERSISTENCE_DEFAULTS: ChatMediaPersistenceDependencies = {
  persistMediaList: persistDurableGeneratedMediaList,
  cleanupMedia: cleanupDurableGeneratedMediaUploads,
}

export async function persistChatInlineMedia(
  context: JobExecutionContext,
  input: LoadedChatJob,
  media: readonly GeneratedMedia[],
  dependencies: ChatMediaPersistenceDependencies,
): Promise<DurableMediaPersistenceBatch> {
  return dependencies.persistMediaList({
    userId: input.userId,
    conversationId: input.conversationId,
    generationId: context.job.id,
    baseUrl: input.selection.capability.provider.baseUrl,
    apiKey: input.selection.apiKey,
    authType: input.selection.authType ?? 'bearer',
    signal: context.signal,
  }, media, {
    ...jobAssetUploadLifecycle({
      client: input.client,
      fence: context.fence,
      principalId: input.userId,
    }),
  })
}

export async function cleanupChatInlineMedia(
  context: JobExecutionContext,
  input: LoadedChatJob,
  batch: DurableMediaPersistenceBatch,
  dependencies: ChatMediaPersistenceDependencies,
): Promise<void> {
  await dependencies.cleanupMedia({
    userId: input.userId,
    conversationId: input.conversationId,
    generationId: context.job.id,
  }, batch.receipts)
}

export type { GeneratedMedia, DurableMediaPersistenceBatch }
