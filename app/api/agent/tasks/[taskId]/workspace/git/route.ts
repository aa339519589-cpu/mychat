import { type NextRequest } from 'next/server'
import { resolveAuth } from '@/lib/api/guard'
import { json } from '@/lib/api/response'
import { readWorkspaceAuthorityView } from '@/lib/agent/workspace-authority-view'

export async function GET(_request: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const auth = await resolveAuth()
  if (!auth.supabase || !auth.userId) return json({ error: '未登录' }, 401)
  const { taskId } = await params
  try {
    const [{ data: task }, view] = await Promise.all([
      auth.supabase.from('agent_tasks').select('agent_branch').eq('id', taskId)
        .eq('user_id', auth.userId).maybeSingle(),
      readWorkspaceAuthorityView(auth.supabase, auth.userId, taskId),
    ])
    if (!view) return json({ ok: true, hasChanges: false, changedFiles: [], commitSha: null })
    return json({
      ok: true,
      currentBranch: task?.agent_branch ?? null,
      changedFiles: view.manifest.entries.map(entry => ({
        path: entry.path,
        status: entry.kind === 'deleted' ? 'D' : entry.kind === 'file' || entry.kind === 'symlink' ? 'M' : 'M',
      })),
      hasChanges: view.manifest.entries.length > 0,
      commitSha: view.authority.head,
      authoritySnapshotId: view.authority.snapshotId,
      authorityVersion: view.authority.version,
    })
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Workspace authority 不可用' }, 503)
  }
}

export async function POST() {
  return json({ error: 'HTTP 直发已停用；请通过 /api/code/apply 创建确认绑定的耐久发布 Job。' }, 410)
}
