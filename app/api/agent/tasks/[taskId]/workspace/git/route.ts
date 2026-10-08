import { type NextRequest } from 'next/server'
import { resolveAuth } from '@/lib/api/guard'
import { json } from '@/lib/api/response'
import { readWorkspaceAuthorityView } from '@/lib/agent/workspace-authority-view'
import { summarizeWorkspaceChanges, workspaceGitChangeStatus } from '@/lib/agent/workspace-change-summary'

export async function GET(request: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const auth = await resolveAuth(request)
  if (!auth.supabase || !auth.userId) return json({ error: '未登录' }, 401)
  const { taskId } = await params
  try {
    const [{ data: task }, view] = await Promise.all([
      auth.supabase.from('agent_tasks').select('agent_branch').eq('id', taskId)
        .eq('user_id', auth.userId).maybeSingle(),
      readWorkspaceAuthorityView(auth.supabase, auth.userId, taskId),
    ])
    if (!view) return json({ ok: true, hasChanges: false, changedFiles: [], commitSha: null })
    const changes = summarizeWorkspaceChanges(view.manifest.entries)
    return json({
      ok: true,
      currentBranch: task?.agent_branch ?? null,
      changedFiles: changes.changedFiles.map(file => ({
        path: file.path,
        status: workspaceGitChangeStatus[file.status],
      })),
      hasChanges: changes.hasChanges,
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
