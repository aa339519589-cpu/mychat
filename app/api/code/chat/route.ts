import { NextRequest } from 'next/server'
import { apiErrorResponseV1 } from '@/lib/api/errors'
import { enforceQuotaLimit, enforceRequestRateLimit, resolveAuth } from '@/lib/api/guard'
import { readJson, requestId } from '@/lib/api/request'
import { parseCodeChatRequest } from '@/lib/code-agent/request'
import { getCurrentGitHubConnectionStatus } from '@/lib/github-session'
import { sha256JobValue } from '@/lib/jobs/canonical'
import type { JsonObject } from '@/lib/jobs/contracts'
import { jobMetrics } from '@/lib/observability/job-metrics'
import { expensiveWriteMaintenanceResponse } from '@/lib/api/maintenance'
import { createAdminClient } from '@/lib/supabase/admin'

function latestGoal(messages: Array<{ role: string; content: string }>): string {
  return [...messages].reverse().find(message => message.role === 'user')?.content.slice(0, 10_000)
    || '代码任务'
}

export async function POST(request: NextRequest) {
  const maintenance = expensiveWriteMaintenanceResponse(request)
  if (maintenance) return maintenance
  const auth = await resolveAuth()
  const rate = await enforceRequestRateLimit(auth, request)
  if (rate.response) return rate.response
  if (!auth.supabase || !auth.userId) return apiErrorResponseV1(request, {
    status: auth.authUnavailable ? 503 : 401,
    code: auth.authUnavailable ? 'AUTH_DEPENDENCY_UNAVAILABLE' : 'AUTH_REQUIRED',
    message: auth.authUnavailable ? '认证服务暂时不可用' : '请先登录',
    retryable: auth.authUnavailable === true,
  })
  let body
  try {
    body = parseCodeChatRequest(await readJson(request, { maxBytes: 4 * 1024 * 1024 }))
  } catch (error) {
    return apiErrorResponseV1(request, {
      status: 400, code: 'INVALID_REQUEST',
      message: error instanceof Error ? error.message : '请求参数无效', retryable: false,
    })
  }
  const quota = await enforceQuotaLimit(auth)
  if (quota.response) return quota.response
  if (!body.repo || !body.sessionId || !body.responseId) return apiErrorResponseV1(request, {
    status: 400, code: 'INVALID_REQUEST',
    message: 'Code Agent 需要 repo、sessionId 和 responseId', retryable: false,
  })
  let connection
  try {
    connection = await getCurrentGitHubConnectionStatus({
      purpose: 'agent.enqueue', requestId: requestId(request),
    })
  } catch {
    return apiErrorResponseV1(request, {
      status: 503, code: 'DEPENDENCY_UNAVAILABLE', message: 'GitHub 连接服务暂时不可用', retryable: true,
    })
  }
  if (!connection) return apiErrorResponseV1(request, {
    status: 401, code: 'AUTH_REQUIRED', message: '未连接 GitHub 或账号会话已变化', retryable: false,
  })

  const taskId = body.taskId ?? crypto.randomUUID()
  const [{ data: task, error: taskError }, { data: session, error: sessionError }, { data: userMessage, error: messageError }] =
    await Promise.all([
      auth.supabase.from('agent_tasks').select('id,repo,status').eq('id', taskId)
        .eq('user_id', auth.userId).maybeSingle(),
      auth.supabase.from('code_sessions').select('id,repo').eq('id', body.sessionId)
        .eq('user_id', auth.userId).maybeSingle(),
      auth.supabase.from('code_messages').select('id').eq('session_id', body.sessionId)
        .eq('user_id', auth.userId).eq('role', 'user').order('created_at', { ascending: false })
        .limit(1).maybeSingle(),
    ])
  if (taskError || sessionError || messageError) return apiErrorResponseV1(request, {
    status: 503, code: 'DEPENDENCY_UNAVAILABLE', message: 'Code 上下文暂时不可用', retryable: true,
  })
  if (!session || !userMessage || (task && task.repo !== body.repo) || session.repo !== body.repo) {
    return apiErrorResponseV1(request, {
      status: 409, code: 'CONFLICT', message: '任务、会话或仓库上下文不一致', retryable: false,
    })
  }
  if (task && (task.status === 'cancelled' || task.status === 'completed')) return apiErrorResponseV1(request, {
    status: 409, code: 'CONFLICT', message: `当前任务状态 ${task.status} 不可继续`, retryable: false,
  })

  const jobId = crypto.randomUUID()
  const payload: JsonObject = {
    schemaVersion: 1,
    repo: body.repo,
    tier: body.tier,
    sessionId: body.sessionId,
    responseId: body.responseId,
    userMessageId: userMessage.id,
    usingBalance: quota.usingBalance,
  }
  try {
    const inputHash = sha256JobValue(payload)
    const commandClient = createAdminClient()
    if (!commandClient) throw new Error('command authority unavailable')
    const { data, error } = await commandClient.rpc('enqueue_agent_task_job', {
      input_user_id: auth.userId,
      input_task_id: taskId,
      input_goal: latestGoal(body.messages),
      input_repo: body.repo,
      input_session_id: body.sessionId,
      input_response_id: body.responseId,
      input_user_message_id: userMessage.id,
      input_job_id: jobId,
      input_auth_class: auth.isAnonymous ? 'anonymous' : 'registered',
      input_idempotency_key: `agent:${taskId}:${body.responseId}`,
      input_input_hash: inputHash,
      input_payload: payload,
    })
    const result = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null
    const job = result?.job as Record<string, unknown> | undefined
    if (error || !job || typeof job.id !== 'string' || typeof job.status !== 'string') {
      throw new Error('atomic enqueue failed')
    }
    const created = result?.enqueued === true && result?.replayed !== true
    if (created) jobMetrics.recordEnqueued('agent_task')
    return Response.json({
      schemaVersion: 1,
      jobId: job.id,
      taskId,
      responseId: body.responseId,
      status: job.status,
      created,
      streamUrl: `/api/v1/jobs/${job.id}/events?from_seq=0`,
    }, {
      status: 202,
      headers: { 'Cache-Control': 'no-store', 'Location': `/api/v1/jobs/${job.id}` },
    })
  } catch {
    return apiErrorResponseV1(request, {
      status: 503, code: 'DEPENDENCY_UNAVAILABLE', message: 'Agent 作业暂时无法入队', retryable: true,
    })
  }
}
