import { type NextRequest } from 'next/server'
import { resolveAuth } from '@/lib/api/guard'
import { json } from '@/lib/api/response'

export async function GET(_request: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const auth = await resolveAuth()
  if (!auth.supabase || !auth.userId) return json({ error: '未登录' }, 401)
  const { taskId } = await params
  const [{ data: task }, { data: head, error }] = await Promise.all([
    auth.supabase.from('agent_tasks').select('id,repo,branch,agent_branch').eq('id', taskId)
      .eq('user_id', auth.userId).maybeSingle(),
    auth.supabase.from('agent_workspace_heads')
      .select('snapshot_id,manifest_digest,tree_digest,head,version,updated_at')
      .eq('task_id', taskId).eq('user_id', auth.userId).maybeSingle(),
  ])
  if (!task) return json({ error: '任务不存在' }, 404)
  if (error) return json({ error: 'Workspace authority 暂时不可用' }, 503)
  if (!head) return json({ status: 'not_hydrated', repo: task.repo, branch: task.agent_branch ?? task.branch })
  return json({
    status: 'durable', repo: task.repo, branch: task.agent_branch ?? task.branch,
    snapshotId: head.snapshot_id, manifestDigest: head.manifest_digest,
    treeDigest: head.tree_digest, commit: head.head, version: head.version,
    updatedAt: head.updated_at,
  })
}

export async function POST() {
  return json({ error: 'HTTP workspace 创建已停用；Worker 会在领取 Agent Job 后按需 hydrate。' }, 410)
}
