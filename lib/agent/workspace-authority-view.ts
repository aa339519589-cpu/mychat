import type { SupabaseClient } from '@/lib/supabase/types'
import { parseAndVerifyManifest } from './snapshot/cas-integrity'
import type { SnapshotManifest } from './snapshot/cas-types'
import { readWorkspaceAuthority, type WorkspaceAuthority } from './workspace-authority'

export type WorkspaceAuthorityView = {
  authority: WorkspaceAuthority
  manifest: SnapshotManifest
}

export async function readWorkspaceAuthorityView(
  client: SupabaseClient,
  userId: string,
  taskId: string,
): Promise<WorkspaceAuthorityView | null> {
  const authority = await readWorkspaceAuthority(client, userId, taskId)
  if (!authority) return null
  const { data, error } = await client.from('agent_artifacts').select('content')
    .eq('task_id', taskId).eq('user_id', userId)
    .eq('title', `snapshot:${authority.snapshotId}`).maybeSingle()
  if (error || !data || typeof data.content !== 'string') throw new Error('Workspace CAS manifest 不可用')
  let content: unknown
  try { content = JSON.parse(data.content) } catch { throw new Error('Workspace CAS manifest 格式无效') }
  if (!content || typeof content !== 'object' || Array.isArray(content)
      || (content as { format?: unknown }).format !== 'cas-v1') {
    throw new Error('Workspace CAS envelope 格式无效')
  }
  const verified = parseAndVerifyManifest((content as { manifest?: unknown }).manifest, {
    userId, taskId, snapshotId: authority.snapshotId,
  })
  if (!verified.ok
      || verified.manifest.manifestDigest !== authority.manifestDigest
      || verified.manifest.treeDigest !== authority.treeDigest
      || verified.manifest.head !== authority.head) {
    throw new Error('Workspace DB current-head 与 CAS manifest 不一致')
  }
  return { authority, manifest: verified.manifest }
}
