import { type NextRequest } from 'next/server'
import { resolveAuth } from '@/lib/api/guard'
import { json } from '@/lib/api/response'
import { readWorkspaceAuthorityView } from '@/lib/agent/workspace-authority-view'
import { summarizeWorkspaceChanges } from '@/lib/agent/workspace-change-summary'
import { handleWorkspaceUnifiedDiff } from '@/lib/agent/workspace-unified-diff-route'

export async function GET(_request: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  if (new URL(_request.url).searchParams.has('format')) {
    const { taskId } = await params
    return handleWorkspaceUnifiedDiff(_request, taskId)
  }
  const auth = await resolveAuth(_request)
  if (!auth.supabase || !auth.userId) return json({ error: '未登录' }, 401)
  const { taskId } = await params
  try {
    const view = await readWorkspaceAuthorityView(auth.supabase, auth.userId, taskId)
    if (!view) return json({ diff: '', diffFormat: 'cas-change-summary', ...summarizeWorkspaceChanges([]) })
    const changes = summarizeWorkspaceChanges(view.manifest.entries)
    return json({
      diff: `DB-authoritative CAS ${view.authority.manifestDigest}\n${changes.changedFiles.map(file => `${file.status}\t${file.path}`).join('\n')}`,
      // This compatibility string is a CAS change summary, never patch hunks.
      diffFormat: 'cas-change-summary',
      ...changes,
      snapshotId: view.authority.snapshotId,
      head: view.authority.head,
      manifestDigest: view.authority.manifestDigest,
    })
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Workspace authority 不可用' }, 503)
  }
}
