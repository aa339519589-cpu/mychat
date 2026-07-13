import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  isSafeGeneratedMediaUrl,
  MAX_GENERATED_MEDIA_ITEMS,
  normalizeGeneratedMedia,
  type GeneratedMedia,
} from '@/lib/generated-media'
import {
  type MaterializeGeneratedMediaOptions,
  type ModelEndpointFetcher,
} from '@/lib/llm/media-generation/contracts'
import { materializeOpenAICompatibleMedia } from '@/lib/llm/media-generation/materialize'
import { normalizeOpenAIBaseUrl } from '@/lib/llm/openai-compatible'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  drainGeneratedMediaCleanup,
  queueGeneratedMediaCleanup,
  removeQueuedGeneratedMedia,
} from './media-cleanup'

const GENERATED_MEDIA_BUCKET = 'generated-media'
const MAX_DURABLE_MEDIA_BYTES = 10 * 1024 * 1024
const SAFE_SCOPE_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,127})$/

type StorageError = { message?: string } | null

export type DurableMediaStorageContext = {
  userId: string
  conversationId: string
  generationId: string
  baseUrl: string
  apiKey?: string
  authType: MaterializeGeneratedMediaOptions['authType']
  signal?: AbortSignal
}

export type DurableMediaStorageScope = Pick<
  DurableMediaStorageContext,
  'userId' | 'conversationId' | 'generationId'
>

export type DurableMediaUploadReceipt = {
  bucket: 'generated-media'
  objectKey: string
}

export type DurableMediaPersistence = {
  media: GeneratedMedia
  receipt: DurableMediaUploadReceipt
}

export type DurableMediaPersistenceBatch = {
  media: GeneratedMedia[]
  receipts: DurableMediaUploadReceipt[]
}

export type DurableMediaStorageDependencies = {
  createAdminClient?: () => SupabaseClient | null
  fetcher?: ModelEndpointFetcher
  materializeMedia?: typeof materializeOpenAICompatibleMedia
  randomUUID?: () => string
}

export class DurableMediaStorageError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'invalid_scope'
      | 'invalid_media'
      | 'unsafe_media_url'
      | 'empty_media'
      | 'media_too_large'
      | 'admin_unavailable'
      | 'upload_failed'
      | 'invalid_storage_url'
      | 'invalid_receipt'
      | 'cleanup_failed',
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'DurableMediaStorageError'
  }
}

function safeScopeSegment(value: string, label: string): string {
  const normalized = value.trim()
  if (normalized !== value || !SAFE_SCOPE_SEGMENT.test(normalized)) {
    throw new DurableMediaStorageError(`${label} 无效`, 'invalid_scope')
  }
  return normalized
}

function providerOrigin(baseUrl: string): string {
  try {
    return new URL(normalizeOpenAIBaseUrl(baseUrl)).origin
  } catch (error) {
    throw new DurableMediaStorageError('媒体提供方 Base URL 无效', 'invalid_media', { cause: error })
  }
}

function forcedMaterializationOptions(
  context: DurableMediaStorageContext,
  media: GeneratedMedia,
  originalProviderOrigin: string,
  fetcher?: ModelEndpointFetcher,
): MaterializeGeneratedMediaOptions {
  if (!/^https?:\/\//i.test(media.url)) {
    return {
      baseUrl: context.baseUrl,
      apiKey: context.apiKey,
      authType: context.authType,
      signal: context.signal,
      ...(fetcher ? { fetcher } : {}),
    }
  }

  const mediaOrigin = new URL(media.url).origin
  const sameProviderOrigin = mediaOrigin === originalProviderOrigin
  return {
    // Treat the media host as the materializer's base so stable CDN URLs are
    // downloaded instead of returned unchanged. Credentials remain tied to
    // the original provider origin and are never forwarded to a CDN.
    baseUrl: mediaOrigin,
    apiKey: sameProviderOrigin ? context.apiKey : undefined,
    authType: sameProviderOrigin ? context.authType : 'none',
    signal: context.signal,
    ...(fetcher ? { fetcher } : {}),
  }
}

function decodedMaterializedMedia(
  media: GeneratedMedia,
  expectedType: GeneratedMedia['type'],
): { bytes: Uint8Array; mimeType: string } {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(media.url)
  if (!match) {
    throw new DurableMediaStorageError('媒体未被安全物化', 'invalid_media')
  }
  const mimeType = match[1].toLowerCase()
  if (media.type !== expectedType || !mimeType.startsWith(`${expectedType}/`)) {
    throw new DurableMediaStorageError('媒体类型与 MIME 不匹配', 'invalid_media')
  }
  const bytes = new Uint8Array(Buffer.from(match[2], 'base64'))
  if (!bytes.byteLength) throw new DurableMediaStorageError('媒体内容为空', 'empty_media')
  if (bytes.byteLength > MAX_DURABLE_MEDIA_BYTES) {
    throw new DurableMediaStorageError('媒体超过持久化大小限制', 'media_too_large')
  }
  return { bytes, mimeType }
}

function extensionForMime(mimeType: string): string {
  switch (mimeType) {
    case 'image/png': return 'png'
    case 'image/jpeg':
    case 'image/jpg': return 'jpg'
    case 'image/webp': return 'webp'
    case 'image/gif': return 'gif'
    case 'video/mp4': return 'mp4'
    case 'video/webm': return 'webm'
    case 'video/quicktime': return 'mov'
    default: throw new DurableMediaStorageError('媒体 MIME 类型无效', 'invalid_media')
  }
}

function serviceRoleClient(dependencies: DurableMediaStorageDependencies): SupabaseClient {
  let client: SupabaseClient | null
  try {
    client = (dependencies.createAdminClient ?? createAdminClient)()
  } catch (error) {
    throw new DurableMediaStorageError('媒体存储服务不可用', 'admin_unavailable', { cause: error })
  }
  if (!client) throw new DurableMediaStorageError('媒体存储服务不可用', 'admin_unavailable')
  return client
}

async function removeOrphan(
  client: SupabaseClient,
  scope: DurableMediaStorageScope,
  objectKey: string,
): Promise<void> {
  try {
    await queueGeneratedMediaCleanup(client, scope, [objectKey], 'orphan_upload')
  } catch {
    // Still attempt the primary cleanup if the receipt store is unavailable.
  }
  await removeQueuedGeneratedMedia(client, [objectKey])
}

function safeScope(scope: DurableMediaStorageScope): {
  userId: string
  conversationId: string
  generationId: string
} {
  return {
    userId: safeScopeSegment(scope.userId, '用户 ID'),
    conversationId: safeScopeSegment(scope.conversationId, '会话 ID'),
    generationId: safeScopeSegment(scope.generationId, '生成 ID'),
  }
}

function validatedReceiptKey(
  scope: ReturnType<typeof safeScope>,
  receipt: DurableMediaUploadReceipt,
): string {
  const parts = receipt.objectKey.split('/')
  const asset = parts[3] ?? ''
  const validAsset = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,127})\.(?:png|jpg|webp|gif|mp4|webm|mov)$/.test(asset)
  if (receipt.bucket !== GENERATED_MEDIA_BUCKET
    || parts.length !== 4
    || parts[0] !== scope.userId
    || parts[1] !== scope.conversationId
    || parts[2] !== scope.generationId
    || !validAsset) {
    throw new DurableMediaStorageError('媒体清理凭据无效', 'invalid_receipt')
  }
  return receipt.objectKey
}

export async function cleanupDurableGeneratedMediaUploads(
  scopeInput: DurableMediaStorageScope,
  receipts: readonly DurableMediaUploadReceipt[],
  dependencies: Pick<DurableMediaStorageDependencies, 'createAdminClient'> = {},
): Promise<void> {
  const scope = safeScope(scopeInput)
  const objectKeys = [...new Set(receipts.map(receipt => validatedReceiptKey(scope, receipt)))]
  if (!objectKeys.length) return
  const client = serviceRoleClient(dependencies)
  try {
    await queueGeneratedMediaCleanup(client, scope, objectKeys, 'orphan_upload')
  } catch {
    // Storage removal can still succeed even if the retry receipt is unavailable.
  }
  try {
    if (!await removeQueuedGeneratedMedia(client, objectKeys)) throw new Error('storage_cleanup_failed')
  } catch (error) {
    throw new DurableMediaStorageError('生成媒体清理失败', 'cleanup_failed', { cause: error })
  }
}

export async function persistDurableGeneratedMedia(
  context: DurableMediaStorageContext,
  media: GeneratedMedia,
  dependencies: DurableMediaStorageDependencies = {},
): Promise<DurableMediaPersistence> {
  const { userId, conversationId, generationId } = safeScope(context)
  const normalized = normalizeGeneratedMedia(media)
  if (!normalized) throw new DurableMediaStorageError('生成媒体无效', 'invalid_media')
  if (!isSafeGeneratedMediaUrl(normalized.type, normalized.url)) {
    throw new DurableMediaStorageError('生成媒体 URL 指向不安全网络', 'unsafe_media_url')
  }
  const originalProviderOrigin = providerOrigin(context.baseUrl)

  const client = serviceRoleClient(dependencies)
  await drainGeneratedMediaCleanup(client)
  const materialize = dependencies.materializeMedia ?? materializeOpenAICompatibleMedia
  const materialized = await materialize(
    normalized,
    forcedMaterializationOptions(context, normalized, originalProviderOrigin, dependencies.fetcher),
  )
  const { bytes, mimeType } = decodedMaterializedMedia(materialized, normalized.type)
  const extension = extensionForMime(mimeType)
  const assetId = safeScopeSegment(
    (dependencies.randomUUID ?? randomUUID)(),
    '媒体资源 ID',
  )
  const objectKey = `${userId}/${conversationId}/${generationId}/${assetId}.${extension}`
  const bucket = client.storage.from(GENERATED_MEDIA_BUCKET)
  let uploadError: StorageError
  try {
    const result = await bucket.upload(objectKey, bytes, {
      contentType: mimeType,
      cacheControl: '31536000',
      upsert: false,
    })
    uploadError = result.error
  } catch (error) {
    await removeOrphan(client, { userId, conversationId, generationId }, objectKey)
    throw new DurableMediaStorageError('生成媒体上传失败', 'upload_failed', { cause: error })
  }
  if (uploadError) {
    await removeOrphan(client, { userId, conversationId, generationId }, objectKey)
    throw new DurableMediaStorageError('生成媒体上传失败', 'upload_failed')
  }

  let publicUrl: string | undefined
  try {
    publicUrl = bucket.getPublicUrl(objectKey).data?.publicUrl
  } catch (error) {
    await removeOrphan(client, { userId, conversationId, generationId }, objectKey)
    throw new DurableMediaStorageError('媒体存储未返回持久化 URL', 'invalid_storage_url', { cause: error })
  }
  if (!publicUrl || !/^https:\/\//i.test(publicUrl)
    || !isSafeGeneratedMediaUrl(normalized.type, publicUrl)) {
    await removeOrphan(client, { userId, conversationId, generationId }, objectKey)
    throw new DurableMediaStorageError('媒体存储未返回安全的持久化 URL', 'invalid_storage_url')
  }
  return {
    media: {
      type: normalized.type,
      url: publicUrl,
      mimeType,
      ...(normalized.alt ? { alt: normalized.alt } : {}),
    },
    receipt: { bucket: GENERATED_MEDIA_BUCKET, objectKey },
  }
}

export async function persistDurableGeneratedMediaList(
  context: DurableMediaStorageContext,
  media: readonly GeneratedMedia[],
  dependencies: DurableMediaStorageDependencies = {},
): Promise<DurableMediaPersistenceBatch> {
  if (media.length > MAX_GENERATED_MEDIA_ITEMS) {
    throw new DurableMediaStorageError('生成媒体数量超过限制', 'invalid_media')
  }
  const persisted: DurableMediaPersistence[] = []
  try {
    for (const item of media) {
      persisted.push(await persistDurableGeneratedMedia(context, item, dependencies))
    }
  } catch (error) {
    await cleanupDurableGeneratedMediaUploads(
      context,
      persisted.map(item => item.receipt),
      dependencies,
    ).catch(() => undefined)
    throw error
  }
  return {
    media: persisted.map(item => item.media),
    receipts: persisted.map(item => item.receipt),
  }
}
