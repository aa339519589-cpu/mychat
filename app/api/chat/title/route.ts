import { NextRequest } from 'next/server'
import { apiErrorResponseV1 } from '@/lib/api/errors'
import { enforceLimits, resolveAuth } from '@/lib/api/guard'
import { readJson, RequestError } from '@/lib/api/request'
import { validateTitleGenerationRequest } from '@/lib/chat/title-generation'
import { startTitleWorkflow } from '@/lib/chat/title-workflow'
import { resolveChatModelSelection, ChatModelSelectionError } from '@/lib/chat/model-selection'
import { expensiveWriteMaintenanceResponse } from '@/lib/api/maintenance'

export async function POST(request: NextRequest) {
  const maintenance = expensiveWriteMaintenanceResponse(request)
  if (maintenance) return maintenance
  const auth = await resolveAuth()
  if (auth.authUnavailable) return apiErrorResponseV1(request, {
    status: 503, code: 'AUTH_DEPENDENCY_UNAVAILABLE', message: '认证服务暂时不可用', retryable: true,
    headers: { 'Retry-After': '5' },
  })
  let body
  try {
    body = validateTitleGenerationRequest(await readJson(request, { maxBytes: 16 * 1024 }))
  } catch (error) {
    return apiErrorResponseV1(request, {
      status: error instanceof RequestError ? error.status : 400,
      code: 'INVALID_REQUEST',
      message: error instanceof Error ? error.message : '请求体格式错误',
      retryable: false,
    })
  }
  const gate = await enforceLimits(auth, request, { quota: body.endpointId === undefined })
  if (gate.response) return gate.response
  if (!auth.supabase || !auth.userId) return apiErrorResponseV1(request, {
    status: 401, code: 'AUTH_REQUIRED', message: '请先登录', retryable: false,
  })
  const [{ data: conversation, error: conversationError }, { data: source, error: sourceError }] =
    await Promise.all([
      auth.supabase.from('conversations').select('id').eq('id', body.conversationId)
        .eq('user_id', auth.userId).maybeSingle(),
      auth.supabase.from('messages').select('id').eq('conversation_id', body.conversationId)
        .eq('user_id', auth.userId).eq('role', 'assistant').eq('status', 'terminal')
        .order('seq', { ascending: false }).limit(1).maybeSingle(),
    ])
  if (conversationError || sourceError) return apiErrorResponseV1(request, {
    status: 503, code: 'DEPENDENCY_UNAVAILABLE', message: '暂时无法读取对话', retryable: true,
  })
  if (!conversation || !source) return apiErrorResponseV1(request, {
    status: 404, code: 'NOT_FOUND', message: '对话或终态消息不存在', retryable: false,
  })
  try {
    // Validate policy/configuration before accepting work; no provider call is
    // performed in the HTTP process.
    await resolveChatModelSelection({
      tier: '绝句',
      deepResearch: false,
      endpointId: body.endpointId,
      supabase: auth.supabase,
      userId: auth.userId,
    })
    const result = await startTitleWorkflow({
      client: auth.supabase,
      userId: auth.userId,
      authClass: auth.isAnonymous ? 'anonymous' : 'registered',
      conversationId: body.conversationId,
      sourceMessageId: source.id,
      endpointId: body.endpointId,
      usingBalance: gate.usingBalance,
    })
    return Response.json({
      schemaVersion: 1,
      jobId: result.executionId,
      status: result.state,
      created: result.created,
      streamUrl: `/api/v1/jobs/${result.executionId}/events?from_seq=0`,
    }, {
      status: 202,
      headers: { 'Cache-Control': 'no-store', 'Location': `/api/v1/jobs/${result.executionId}` },
    })
  } catch (error) {
    if (error instanceof ChatModelSelectionError) return apiErrorResponseV1(request, {
      status: error.status,
      code: error.status === 404 ? 'NOT_FOUND' : error.status === 401 ? 'AUTH_REQUIRED' : 'CONFLICT',
      message: error.message,
      retryable: error.status >= 500,
    })
    return apiErrorResponseV1(request, {
      status: 503, code: 'DEPENDENCY_UNAVAILABLE', message: '标题作业暂时无法入队', retryable: true,
      headers: { 'Retry-After': '5' },
    })
  }
}
