import { type NextRequest } from 'next/server'
import { resolveAuth } from '@/lib/api/guard'
import { json } from '@/lib/api/response'
import { readWorkspaceAuthorityView } from '@/lib/agent/workspace-authority-view'

export async function GET(_request: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const auth = await resolveAuth()
  if (!auth.supabase || !auth.userId) return json({ error: '未登录' }, 401)
  const { taskId } = await params
  try {
    const view = await readWorkspaceAuthorityView(auth.supabase, auth.userId, taskId)
    if (!view) return json({ diff: '', changedFiles: [], summary: { added: 0, modified: 0, deleted: 0 }, hasChanges: false })
    const changedFiles = view.manifest.entries.map(entry => ({
      path: entry.path,
      status: entry.kind === 'deleted' ? 'deleted' : 'modified',
    }))
    const deleted = view.manifest.entries.filter(entry => entry.kind === 'deleted').length
    const modified = view.manifest.entries.length - deleted
    return json({
      diff: `DB-authoritative CAS ${view.authority.manifestDigest}\n${changedFiles.map(file => `${file.status}\t${file.path}`).join('\n')}`,
      changedFiles,
      summary: { added: 0, modified, deleted },
      hasChanges: changedFiles.length > 0,
      snapshotId: view.authority.snapshotId,
      manifestDigest: view.authority.manifestDigest,
    })
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Workspace authority 不可用' }, 503)
  }
}
