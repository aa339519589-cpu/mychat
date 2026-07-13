// GET  /api/agent/tasks/[taskId]  — 任务详情（含 steps / tool_calls / workspace / artifacts）
import { NextRequest } from "next/server"
import { resolveAuth } from "@/lib/api/guard"
import { json } from "@/lib/api/response"
import { getTaskDetail } from "@/lib/agent/data"

export async function GET(_req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const auth = await resolveAuth()
  if (!auth.supabase || !auth.userId) return json({ error: "未登录" }, 401)

  const { taskId } = await params
  if (!taskId) return json({ error: "缺少 taskId" }, 400)

  const detail = await getTaskDetail(auth.supabase, auth.userId, taskId)
  if (detail.error) return json(detail, 404)

  const { data: latestJob, error: jobError } = await auth.supabase.from('jobs')
    .select('id,status,subject')
    .eq('principal_id', auth.userId)
    .eq('type', 'agent.task')
    .contains('subject', { taskId })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (jobError) return json({ error: '作业状态暂时不可用' }, 503)

  const subject = latestJob?.subject && typeof latestJob.subject === 'object'
    && !Array.isArray(latestJob.subject) ? latestJob.subject as Record<string, unknown> : null
  return json({
    ...detail,
    job: latestJob ? {
      id: latestJob.id,
      status: latestJob.status,
      responseId: typeof subject?.responseId === 'string' ? subject.responseId : null,
      streamUrl: `/api/v1/jobs/${latestJob.id}/events?from_seq=0`,
    } : null,
  })
}
