import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/admin'
import { isJsonValue, type JsonObject } from './contracts'
import { canonicalJobJson, sha256JobBytes } from './canonical'

const JOB_PAYLOAD_BUCKET = 'job-payloads' as const
const MAX_JOB_PAYLOAD_BYTES = 48 * 1024 * 1024
const SCOPE = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,127})$/

export type JobPayloadReference = {
  bucket: typeof JOB_PAYLOAD_BUCKET
  objectKey: string
  sha256: string
  bytes: number
  contentType: 'application/json'
}

export class JobPayloadStorageError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'invalid_scope'
      | 'invalid_payload'
      | 'payload_too_large'
      | 'admin_unavailable'
      | 'upload_failed'
      | 'download_failed'
      | 'integrity_failed'
      | 'cleanup_failed',
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'JobPayloadStorageError'
  }
}

type Dependencies = { createAdminClient?: () => SupabaseClient | null }

function safeSegment(value: string): string {
  if (!SCOPE.test(value)) throw new JobPayloadStorageError('作业载荷作用域无效', 'invalid_scope')
  return value
}

function clientFor(dependencies: Dependencies): SupabaseClient {
  let client: SupabaseClient | null
  try {
    client = (dependencies.createAdminClient ?? createAdminClient)()
  } catch (error) {
    throw new JobPayloadStorageError('作业载荷存储不可用', 'admin_unavailable', { cause: error })
  }
  if (!client) throw new JobPayloadStorageError('作业载荷存储不可用', 'admin_unavailable')
  return client
}

function duplicateUpload(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const record = error as Record<string, unknown>
  return record.statusCode === '409' || record.statusCode === 409
    || (typeof record.message === 'string' && /duplicate|already exists/i.test(record.message))
}

function validateReference(
  reference: JobPayloadReference,
  userId: string,
  jobId: string,
): void {
  const safeUser = safeSegment(userId)
  const safeJob = safeSegment(jobId)
  const expected = `${safeUser}/${safeJob}/${reference.sha256}.json`
  if (reference.bucket !== JOB_PAYLOAD_BUCKET
    || !/^[0-9a-f]{64}$/.test(reference.sha256)
    || !Number.isSafeInteger(reference.bytes)
    || reference.bytes < 2
    || reference.bytes > MAX_JOB_PAYLOAD_BYTES
    || reference.contentType !== 'application/json'
    || reference.objectKey !== expected) {
    throw new JobPayloadStorageError('作业载荷引用无效', 'invalid_payload')
  }
}

export async function persistJobPayload(
  input: { userId: string; jobId: string; payload: JsonObject },
  dependencies: Dependencies = {},
): Promise<JobPayloadReference> {
  const userId = safeSegment(input.userId)
  const jobId = safeSegment(input.jobId)
  let serialized: string
  try {
    serialized = canonicalJobJson(input.payload)
  } catch (error) {
    throw new JobPayloadStorageError('作业载荷格式无效', 'invalid_payload', { cause: error })
  }
  const bytes = new TextEncoder().encode(serialized)
  if (bytes.byteLength > MAX_JOB_PAYLOAD_BYTES) {
    throw new JobPayloadStorageError('作业载荷超过大小限制', 'payload_too_large')
  }
  const sha256 = sha256JobBytes(bytes)
  const objectKey = `${userId}/${jobId}/${sha256}.json`
  const storage = clientFor(dependencies).storage.from(JOB_PAYLOAD_BUCKET)
  let error: unknown
  try {
    ;({ error } = await storage.upload(objectKey, bytes, {
      contentType: 'application/json',
      cacheControl: '0',
      upsert: false,
    }))
  } catch (caught) {
    throw new JobPayloadStorageError('作业载荷上传失败', 'upload_failed', { cause: caught })
  }
  if (error && !duplicateUpload(error)) {
    throw new JobPayloadStorageError('作业载荷上传失败', 'upload_failed')
  }
  return { bucket: JOB_PAYLOAD_BUCKET, objectKey, sha256, bytes: bytes.byteLength, contentType: 'application/json' }
}

export async function loadJobPayload(
  reference: JobPayloadReference,
  scope: { userId: string; jobId: string },
  dependencies: Dependencies = {},
): Promise<JsonObject> {
  validateReference(reference, scope.userId, scope.jobId)
  let data: Blob | null = null
  let error: unknown
  try {
    ;({ data, error } = await clientFor(dependencies).storage
      .from(JOB_PAYLOAD_BUCKET).download(reference.objectKey))
  } catch (caught) {
    throw new JobPayloadStorageError('作业载荷下载失败', 'download_failed', { cause: caught })
  }
  if (error || !data) throw new JobPayloadStorageError('作业载荷下载失败', 'download_failed')
  if (data.size !== reference.bytes || data.size > MAX_JOB_PAYLOAD_BYTES) {
    throw new JobPayloadStorageError('作业载荷完整性校验失败', 'integrity_failed')
  }
  const bytes = new Uint8Array(await data.arrayBuffer())
  if (sha256JobBytes(bytes) !== reference.sha256) {
    throw new JobPayloadStorageError('作业载荷完整性校验失败', 'integrity_failed')
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (!isJsonValue(parsed) || Array.isArray(parsed) || parsed === null || typeof parsed !== 'object') {
      throw new TypeError('payload is not an object')
    }
    return parsed
  } catch (caught) {
    throw new JobPayloadStorageError('作业载荷格式无效', 'invalid_payload', { cause: caught })
  }
}

export async function removeJobPayload(
  reference: JobPayloadReference,
  scope: { userId: string; jobId: string },
  dependencies: Dependencies = {},
): Promise<void> {
  validateReference(reference, scope.userId, scope.jobId)
  try {
    const { error } = await clientFor(dependencies).storage
      .from(JOB_PAYLOAD_BUCKET).remove([reference.objectKey])
    if (error) throw error
  } catch (caught) {
    throw new JobPayloadStorageError('作业载荷清理失败', 'cleanup_failed', { cause: caught })
  }
}
