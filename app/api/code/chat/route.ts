import { NextRequest } from 'next/server'
import { apiErrorResponseV1, type ApiErrorResponseOptions } from '@/lib/api/errors'
import { enforceQuotaLimit, enforceRequestRateLimit, resolveAuth, type AuthCtx } from '@/lib/api/guard'
import { expensiveWriteMaintenanceResponse } from '@/lib/api/maintenance'
import { readJson, requestId } from '@/lib/api/request'
import { releaseTrialCall, reserveTrialCall } from '@/lib/chat/model-access'
import { ChatModelSelectionError, type ChatModelSelection } from '@/lib/chat/model-selection'
import { CodeAgentEnqueueContextError, parseAgentEnqueueResult, resolveCodeAgentEnqueueContext } from '@/lib/code-agent/enqueue-context'
import { resolveCodeModelSelection } from '@/lib/code-agent/model-selection'
import { parseCodeChatRequest, type CodeChatRequest } from '@/lib/code-agent/request'
import { getCurrentGitHubConnectionStatus } from '@/lib/github-session'
import { sha256JobValue } from '@/lib/jobs/canonical'
import type { JsonObject } from '@/lib/jobs/contracts'
import { jobMetrics } from '@/lib/observability/job-metrics'
import { createAdminClient } from '@/lib/supabase/admin'
import type { SupabaseClient } from '@/lib/supabase/types'

type BoundCodeChatRequest = CodeChatRequest & { repo: string; responseId: string; sessionId: string }
type AdmissionPolicy = { response?: Response; selection?: ChatModelSelection; usingBalance?: boolean }
type TrialPolicy = { response?: Response; reserved: boolean; remaining: number | null }

function latestGoal(messages: Array<{ role: string; content: string }>): string {
  return [...messages].reverse().find(message => message.role === 'user')?.content.slice(0, 10_000) || '代码任务'
}
function apiFailure(request: NextRequest, input: ApiErrorResponseOptions): Response {
  return apiErrorResponseV1(request, input)
}
function authFailureResponse(request: NextRequest, auth: AuthCtx): Response {
  const unavailable = auth.authUnavailable === true
  return apiFailure(request, {
    status: unavailable ? 503 : 401,
    code: unavailable ? 'AUTH_DEPENDENCY_UNAVAILABLE' : 'AUTH_REQUIRED',
    message: unavailable ? '认证服务暂时不可用' : '请先登录',
    retryable: unavailable,
  })
}
function boundRequest(body: CodeChatRequest): BoundCodeChatRequest {
  if (!body.repo || !body.sessionId || !body.responseId) {
    throw new CodeAgentEnqueueContextError('conflict', 'Code Agent 需要 repo、sessionId 和 responseId')
  }
  return body as BoundCodeChatRequest
}
async function loadContext(client: SupabaseClient, userId: string, taskId: string, body: BoundCodeChatRequest): Promise<{ userMessageId: string }> {
  const [task, session, userMessage] = await Promise.all([
    client.from('agent_tasks').select('id,repo,status').eq('id', taskId).eq('user_id', userId).maybeSingle(),
    client.from('code_sessions').select('id,repo').eq('id', body.sessionId).eq('user_id', userId).maybeSingle(),
    client.from('code_messages').select('id,session_id').eq('session_id', body.sessionId)
      .eq('user_id', userId).eq('role', 'user').order('created_at', { ascending: false }).limit(1).maybeSingle(),
  ])
  return resolveCodeAgentEnqueueContext({ task, session, userMessage, taskId, sessionId: body.sessionId, repo: body.repo })
}
function contextFailure(request: NextRequest, error: CodeAgentEnqueueContextError): Response {
  if (error.kind === 'dependency') return apiFailure(request, {
    status: 503, code: 'DEPENDENCY_UNAVAILABLE', message: error.message, retryable: true,
  })
  return apiFailure(request, { status: 409, code: 'CONFLICT', message: error.message, retryable: false })
}
function modelSelectionResponse(request: NextRequest, error: ChatModelSelectionError): Response {
  return apiFailure(request, {
    status: error.status,
    code: error.status === 404 ? 'NOT_FOUND' : error.status === 401 ? 'AUTH_REQUIRED' : error.status === 403 ? 'FORBIDDEN' : 'CONFLICT',
    message: error.message,
    retryable: error.status >= 500,
  })
}
async function resolveAdmissionPolicy(request: NextRequest, auth: AuthCtx, body: BoundCodeChatRequest): Promise<AdmissionPolicy> {
  let selection: ChatModelSelection
  try {
    selection = await resolveCodeModelSelection({
      modelId: body.modelId,
      reasoningEffort: body.reasoningEffort,
      supabase: auth.supabase,
      userId: auth.userId,
      allowPremium: true,
    })
  } catch (error) {
    if (error instanceof ChatModelSelectionError) return { response: modelSelectionResponse(request, error) }
    return { response: apiFailure(request, {
      status: 503, code: 'DEPENDENCY_UNAVAILABLE', message: '模型策略暂时不可用', retryable: true,
    }) }
  }
  if (selection.accessClass !== 'quota') return { selection, usingBalance: false }
  try {
    const quota = await enforceQuotaLimit(auth, { quota: true })
    if (quota.response) return { response: quota.response }
    return { selection, usingBalance: quota.usingBalance }
  } catch {
    return { response: apiFailure(request, {
      status: 503, code: 'DEPENDENCY_UNAVAILABLE', message: '额度服务暂时不可用', retryable: true,
    }) }
  }
}
async function reserveModelTrial(
  request: NextRequest,
  auth: AuthCtx,
  body: BoundCodeChatRequest,
  selection: ChatModelSelection,
): Promise<TrialPolicy> {
  if (selection.accessClass === 'quota' || auth.isOwner === true) {
    return { reserved: false, remaining: null }
  }
  try {
    const trial = await reserveTrialCall(auth.supabase!, auth.userId!, body.responseId, selection.model)
    if (!trial.allowed) return {
      reserved: false,
      remaining: 0,
      response: apiFailure(request, {
        status: 403,
        code: 'QUOTA_EXCEEDED',
        message: '其他模型共享的 3 次额度已用完，当前剩余 0 次。请切换到基础模型继续使用。',
        retryable: false,
        details: { trialLimit: 3, trialRemaining: 0 },
      }),
    }
    return { reserved: !trial.duplicate, remaining: trial.remaining }
  } catch (error) {
    return {
      reserved: false,
      remaining: null,
      response: apiFailure(request, {
        status: 503,
        code: 'DEPENDENCY_UNAVAILABLE',
        message: error instanceof Error ? error.message : '其他模型额度服务暂时不可用',
        retryable: true,
      }),
    }
  }
}
async function githubConnectionFailure(request: NextRequest): Promise<Response | null> {
  try {
    const connection = await getCurrentGitHubConnectionStatus({ purpose: 'agent.enqueue', requestId: requestId(request) })
    return connection ? null : apiFailure(request, {
      status: 401, code: 'AUTH_REQUIRED', message: '未连接 GitHub 或账号会话已变化', retryable: false,
    })
  } catch {
    return apiFailure(request, {
      status: 503, code: 'DEPENDENCY_UNAVAILABLE', message: 'GitHub 连接服务暂时不可用', retryable: true,
    })
  }
}
async function enqueueAgentTask(input: {
  userId: string
  isAnonymous: boolean
  usingBalance: boolean
  taskId: string
  body: BoundCodeChatRequest
  selection: ChatModelSelection
  userMessageId: string
}): Promise<{ jobId: string; status: string; created: boolean }> {
  const jobId = crypto.randomUUID()
  const payload: JsonObject = {
    schemaVersion: 1,
    repo: input.body.repo,
    modelId: input.selection.model,
    accessClass: input.selection.accessClass,
    ...(input.selection.reasoningEffort ? { reasoningEffort: input.selection.reasoningEffort } : {}),
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
function acceptedResponse(taskId: string, responseId: string, job: { jobId: string; status: string; created: boolean }, trialRemaining: number | null): Response {
  if (job.created) jobMetrics.recordEnqueued('agent_task')
  return Response.json({
    schemaVersion: 1,
    jobId: job.jobId,
    taskId,
    responseId,
    status: job.status,
    created: job.created,
    streamUrl: `/api/v1/jobs/${job.jobId}/events?from_seq=0`,
    ...(trialRemaining !== null ? { trialRemaining, trialLimit: 3 } : {}),
  }, { status: 202, headers: { 'Cache-Control': 'no-store', Location: `/api/v1/jobs/${job.jobId}` } })
}
async function completeEnqueue(request: NextRequest, input: {
  client: SupabaseClient
  userId: string
  isAnonymous: boolean
  body: BoundCodeChatRequest
  selection: ChatModelSelection
  usingBalance: boolean
  trial: TrialPolicy
}): Promise<Response> {
  const taskId = input.body.taskId ?? crypto.randomUUID()
  try {
    const context = await loadContext(input.client, input.userId, taskId, input.body)
    const job = await enqueueAgentTask({
      userId: input.userId,
      isAnonymous: input.isAnonymous,
      usingBalance: input.usingBalance,
      taskId,
      body: input.body,
      selection: input.selection,
      userMessageId: context.userMessageId,
    })
    return acceptedResponse(taskId, input.body.responseId, job, input.trial.remaining)
  } catch (error) {
    if (input.trial.reserved) {
      await releaseTrialCall(input.client, input.userId, input.body.responseId).catch(() => undefined)
    }
    if (error instanceof CodeAgentEnqueueContextError) return contextFailure(request, error)
    return apiFailure(request, {
      status: 503, code: 'DEPENDENCY_UNAVAILABLE', message: 'Agent 作业暂时无法入队', retryable: true,
    })
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  const maintenance = expensiveWriteMaintenanceResponse(request)
  if (maintenance) return maintenance
  const auth = await resolveAuth()
  const rate = await enforceRequestRateLimit(auth, request)
  if (rate.response) return rate.response
  if (!auth.supabase || !auth.userId) return authFailureResponse(request, auth)
  let body: BoundCodeChatRequest
  try {
    body = boundRequest(parseCodeChatRequest(await readJson(request, { maxBytes: 4 * 1024 * 1024 })))
  } catch (error) {
    const message = error instanceof Error ? error.message : '请求参数无效'
    return apiFailure(request, { status: 400, code: 'INVALID_REQUEST', message, retryable: false })
  }
  const policy = await resolveAdmissionPolicy(request, auth, body)
  if (policy.response) return policy.response
  if (!policy.selection || policy.usingBalance === undefined) return apiFailure(request, {
    status: 503, code: 'DEPENDENCY_UNAVAILABLE', message: '模型准入策略暂时不可用', retryable: true,
  })
  const connectionFailure = await githubConnectionFailure(request)
  if (connectionFailure) return connectionFailure
  const trial = await reserveModelTrial(request, auth, body, policy.selection)
  if (trial.response) return trial.response
  return completeEnqueue(request, {
    client: auth.supabase,
    userId: auth.userId,
    isAnonymous: auth.isAnonymous,
    body,
    selection: policy.selection,
    usingBalance: policy.usingBalance,
    trial,
  })
}
