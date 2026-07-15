import { type NextRequest } from 'next/server'
import { apiErrorResponseV1 } from '@/lib/api/errors'
import { enforceRequestRateLimit, resolveAuth } from '@/lib/api/guard'
import { readJson, requestErrorResponse, requestId } from '@/lib/api/request'
import { applyCodeChanges } from '@/lib/code-agent/apply'
import { parseCodeApplyRequest } from '@/lib/code-agent/apply-request'
import { getCurrentGitHubConnectionStatus } from '@/lib/github-session'
import { expensiveWriteMaintenanceResponse } from '@/lib/api/maintenance'

/** DB-only transport: authenticate, strictly validate and atomically enqueue. */
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

  let input
  try {
    input = parseCodeApplyRequest(await readJson(request, { maxBytes: 900_000 }))
  } catch (error) {
    return requestErrorResponse(error)
  }
  try {
    const connection = await getCurrentGitHubConnectionStatus({
      purpose: 'agent.operation.enqueue', requestId: requestId(request),
    })
    if (!connection) return apiErrorResponseV1(request, {
      status: 401, code: 'AUTH_REQUIRED',
      message: '未连接 GitHub 或账号会话已变化', retryable: false,
    })
    const outcome = await applyCodeChanges({
      request: input,
      client: auth.supabase,
      userId: auth.userId,
      authClass: auth.isAnonymous ? 'anonymous' : 'registered',
    })
    return Response.json(outcome.body, { status: outcome.status, headers: outcome.headers })
  } catch (error) {
    return apiErrorResponseV1(request, {
      status: 503,
      code: 'DEPENDENCY_UNAVAILABLE',
      message: error instanceof Error ? error.message : '发布控制面暂时不可用',
      retryable: true,
    })
  }
}
