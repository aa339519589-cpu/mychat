import { type NextRequest } from 'next/server'
import { resolveAuth } from '@/lib/api/guard'
import { json } from '@/lib/api/response'
import { listSnapshotsFromArtifacts } from '@/lib/agent/snapshot/artifact'

export async function GET(_request: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const auth = await resolveAuth()
  if (!auth.supabase || !auth.userId) return json({ error: '未登录' }, 401)
  const { taskId } = await params
  const { data: task } = await auth.supabase.from('agent_tasks').select('id')
    .eq('id', taskId).eq('user_id', auth.userId).maybeSingle()
  if (!task) return json({ error: '任务不存在' }, 404)
  return json({ snapshots: await listSnapshotsFromArtifacts(auth.supabase, auth.userId, taskId) })
}

export async function POST() {
  return json({ error: '手动 HTTP snapshot 已停用；Worker 在每次变更后自动推进 DB current-head。' }, 410)
}
