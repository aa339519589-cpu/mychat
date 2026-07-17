import type { SupabaseClient } from '@/lib/supabase/types'
import type { GeneratedMedia } from '@/lib/generated-media'
import type { DurableMediaStorageDependencies } from '@/lib/generation/media-storage'
import type { JobFence } from './contracts'
import { JobRuntimeError } from './errors'

type AssetState = 'reserved' | 'uploaded'

async function recordAsset(input: {
  client: SupabaseClient
  fence: JobFence
  principalId: string
  objectKey: string
  mediaType: GeneratedMedia['type']
  mimeType: string
  bytes: number
  state: AssetState
}): Promise<void> {
  const { data, error } = await input.client.rpc('record_job_asset', {
    input_job_id: input.fence.jobId,
    input_worker_id: input.fence.workerId,
    input_lease_version: input.fence.leaseVersion,
    input_principal_id: input.principalId,
    input_bucket: 'generated-media',
    input_object_key: input.objectKey,
    input_media_type: input.mediaType,
    input_mime_type: input.mimeType,
    input_bytes: input.bytes,
    input_state: input.state,
  })
  if (error) throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Asset receipt store is unavailable', {
    details: { databaseCode: error.code ?? 'unknown' },
  })
  const row = Array.isArray(data) ? data[0] : data
  if (!row || typeof row !== 'object' || (row as { recorded?: unknown }).recorded !== true) {
    const reason = row && typeof row === 'object' && typeof (row as { reason?: unknown }).reason === 'string'
      ? (row as { reason: string }).reason
      : 'stale_fence'
    throw new JobRuntimeError(
      reason === 'cancel_requested' ? 'JOB_CANCEL_REQUESTED' : 'JOB_LEASE_STALE',
      reason === 'cancel_requested' ? 'Job cancellation was requested' : 'Asset receipt fence was rejected',
    )
  }
}

export function jobAssetUploadLifecycle(input: {
  client: SupabaseClient
  fence: JobFence
  principalId: string
}): Pick<DurableMediaStorageDependencies, 'beforeUpload' | 'afterUpload'> {
  const transition = (state: AssetState): NonNullable<DurableMediaStorageDependencies['beforeUpload']> =>
    async asset => recordAsset({
      ...input,
      objectKey: asset.receipt.objectKey,
      mediaType: asset.type,
      mimeType: asset.mimeType,
      bytes: asset.bytes,
      state,
    })
  return { beforeUpload: transition('reserved'), afterUpload: transition('uploaded') }
}
