// POST /api/agent/tasks/[taskId]/cancel — 取消任务
import { NextRequest } from "next/server"
import { resolveAuth } from "@/lib/api/guard"
import { json } from "@/lib/api/response"
import { SupabaseJobRepository } from '@/lib/jobs/supabase-repository'

export async function POST(_req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const auth = await resolveAuth()
  if (!auth.supabase || !auth.userId) return json({ error: "未登录" }, 401)

  const { taskId } = await params
  const { data: activeJob, error: jobError } = await auth.supabase.from('jobs')
    .select('id')
    .eq('principal_id', auth.userId)
    .in('type', ['agent.task', 'agent.operation'])
    .contains('subject', { taskId })
    .in('status', ['queued', 'leased', 'running', 'awaiting_input', 'cancelling'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (jobError) return json({ error: '作业状态暂时不可用' }, 503)
  if (activeJob) {
    try {
      await new SupabaseJobRepository().cancel({
        jobId: activeJob.id,
        principalId: auth.userId,
        reason: 'user_requested',
      })
    } catch {
      return json({ error: '作业取消暂时不可用' }, 503)
    }
    return json({ ok: true, status: 'cancelling', jobId: activeJob.id })
  }
  const { data, error } = await auth.supabase.rpc('cancel_idle_agent_task', {
    input_task_id: taskId,
  })
  const result = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null
  if (error || result?.ok !== true) return json({ error: '任务取消失败' }, 400)
  return json(result)
}
