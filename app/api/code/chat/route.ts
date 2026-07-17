import { NextRequest } from 'next/server'
import { apiErrorResponseV1, type ApiErrorResponseOptions } from '@/lib/api/errors'
import { enforceQuotaLimit, enforceRequestRateLimit, resolveAuth } from '@/lib/api/guard'
import { expensiveWriteMaintenanceResponse } from '@/lib/api/maintenance'
import { readJson, requestId } from '@/lib/api/request'
import {
  CodeAgentEnqueueContextError,
  parseAgentEnqueueResult,
  resolveCodeAgentEnqueueContext,
} from '@/lib/code-agent/enqueue-context'
import { parseCodeChatRequest, type CodeChatRequest } from '@/lib/code-agent/request'
import { getCurrentGitHubConnectionStatus } from '@/lib/github-session'
import { sha256JobValue } from '@/lib/jobs/canonical'
import type { JsonObject } from '@/lib/jobs/contracts'
import { jobMetrics } from '@/lib/observability/job-metrics'
import { createAdminClient } from '@/lib/supabase/admin'
import type { SupabaseClient } from '@/lib/supabase/types'

type BoundCodeChatRequest = CodeChatRequest & {
  repo: string
  responseId: string
  sessionId: string
}

function latestGoal(messages: Array<{ role: string; content: string }>): string {
  return [...messages].reverse().find(message => message.role === 'user')?.content.slice(0, 10_000)
    || '代码任务'
}

function apiFailure(request: NextRequest, input: ApiErrorResponseOptions): Response {
  return apiErrorResponseV1(request, input)
}

function boundRequest(body: CodeChatRequest): BoundCodeChatRequest {
  if (!body.repo || !body.sessionId || !body.responseId) {
    throw new CodeAgentEnqueueContextError(
      'conflict',
      'Code Agent 需要 repo、sessionId 和 responseId',
    )
  }
  return body as BoundCodeChatRequest
}

async function loadContext(
  client: SupabaseClient,
  userId: string,
  taskId: string,
  body: BoundCodeChatRequest,
): Promise<{ userMessageId: string }> {
  const [task, session, userMessage] = await Promise.all([
    client.from('agent_tasks').select('id,repo,status').eq('id', taskId)
      .eq('user_id', userId).maybeSingle(),
    client.from('code_sessions').select('id,repo').eq('id', body.sessionId)
      .eq('user_id', userId).maybeSingle(),
    client.from('code_messages').select('id,session_id').eq('session_id', body.sessionId)
      .eq('user_id', userId).eq('role', 'user').order('created_at', { ascending: false })
      .limit(1).maybeSingle(),
  ])
  return resolveCodeAgentEnqueueContext({
    task,
    session,
    userMessage,
    taskId,
    sessionId: body.sessionId,
    repo: body.repo,
  })
}

function contextFailure(request: NextRequest, error: CodeAgentEnqueueContextError): Response {
  if (error.kind === 'dependency') return apiFailure(request, {
    status: 503,
    code: 'DEPENDENCY_UNAVAILABLE',
    message: error.message,
    retryable: true,
  })
  return apiFailure(request, {
    status: 409,
    code: 'CONFLICT',
    message: error.message,
    retryable: false,
  })
}

async function githubConnectionFailure(request: NextRequest): Promise<Response | null> {
  try {
    const connection = await getCurrentGitHubConnectionStatus({
      purpose: 'agent.enqueue',
      requestId: requestId(request),
    })
    return connection ? null : apiFailure(request, {
      status: 401,
      code: 'AUTH_REQUIRED',
      message: '未连接 GitHub 或账号会话已变化',
      retryable: false,
    })
  } catch {
    return apiFailure(request, {
      status: 503,
      code: 'DEPENDENCY_UNAVAILABLE',
      message: 'GitHub 连接服务暂时不可用',
      retryable: true,
    })
  }
}

async function enqueueAgentTask(input: {
  userId: string
  isAnonymous: boolean
  usingBalance: boolean
  taskId: string
  body: BoundCodeChatRequest
  userMessageId: string
}): Promise<{ jobId: string; status: string; created: boolean }> {
  const jobId = crypto.randomUUID()
  const payload: JsonObject = {
    schemaVersion: 1,
    repo: input.body.repo,
    tier: input.body.tier,
    sessionId: input.body.sessionId,
    responseId: input.body.responseId,
    userMessageId: input.userMessageId,
    usingBalance: input.usingBalance,
  }
  const commandClient = createAdminClient()
  if (!commandClient) throw new Error('command authority unavailable')
  const response = await commandClient.rpc('enqueue_agent_task_job', {
    input_user_id: input.userId,
    input_task_id: input.taskId,
    input_goal: latestGoal(input.body.messages),
    input_repo: input.body.repo,
    input_session_id: input.body.sessionId,
    input_response_id: input.body.responseId,
    input_user_message_id: input.userMessageId,
    input_job_id: jobId,
    input_auth_class: input.isAnonymous ? 'anonymous' : 'registered',
    input_idempotency_key: `agent:${input.taskId}:${input.body.responseId}`,
    input_input_hash: sha256JobValue(payload),
    input_payload: payload,
  })
  const result = parseAgentEnqueueResult(response.data, response.error)
  if (!result) throw new Error('atomic enqueue failed')
  return result
}

function acceptedResponse(
  taskId: string,
  responseId: string,
  job: { jobId: string; status: string; created: boolean },
): Response {
  if (job.created) jobMetrics.recordEnqueued('agent_task')
  return Response.json({
    schemaVersion: 1,
    jobId: job.jobId,
    taskId,
    responseId,
    status: job.status,
    created: job.created,
    streamUrl: `/api/v1/jobs/${job.jobId}/events?from_seq=0`,
  }, {
    status: 202,
    headers: {
      'Cache-Control': 'no-store',
      Location: `/api/v1/jobs/${job.jobId}`,
    },
  })
}

export async function POST(request: NextRequest): Promise<Response> {
  const maintenance = expensiveWriteMaintenanceResponse(request)
  if (maintenance) return maintenance
  const auth = await resolveAuth()
  const rate = await enforceRequestRateLimit(auth, request)
  if (rate.response) return rate.response
  if (!auth.supabase || !auth.userId) return apiFailure(request, {
    status: auth.authUnavailable ? 503 : 401,
    code: auth.authUnavailable ? 'AUTH_DEPENDENCY_UNAVAILABLE' : 'AUTH_REQUIRED',
    message: auth.authUnavailable ? '认证服务暂时不可用' : '请先登录',
    retryable: auth.authUnavailable === true,
  })

  let body: BoundCodeChatRequest
  try {
    body = boundRequest(parseCodeChatRequest(await readJson(request, { maxBytes: 4 * 1024 * 1024 })))
  } catch (error) {
    const message = error instanceof Error ? error.message : '请求参数无效'
    return apiFailure(request, { status: 400, code: 'INVALID_REQUEST', message, retryable: false })
  }
  const quota = await enforceQuotaLimit(auth)
  if (quota.response) return quota.response

  const connectionFailure = await githubConnectionFailure(request)
  if (connectionFailure) return connectionFailure

  const taskId = body.taskId ?? crypto.randomUUID()
  try {
    const context = await loadContext(auth.supabase, auth.userId, taskId, body)
    const job = await enqueueAgentTask({
      userId: auth.userId,
      isAnonymous: auth.isAnonymous,
      usingBalance: quota.usingBalance,
      taskId,
      body,
      userMessageId: context.userMessageId,
    })
    return acceptedResponse(taskId, body.responseId, job)
  } catch (error) {
    if (error instanceof CodeAgentEnqueueContextError) return contextFailure(request, error)
    return apiFailure(request, {
      status: 503,
      code: 'DEPENDENCY_UNAVAILABLE',
      message: 'Agent 作业暂时无法入队',
      retryable: true,
    })
  }
}
