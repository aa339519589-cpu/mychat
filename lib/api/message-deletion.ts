import { apiErrorResponseV1, type ApiErrorCode } from './errors'
import { enforceRequestRateLimit, resolveAuth, type AuthCtx, type RequestRateGate } from './guard'
import { readJson, requestId, RequestError } from './request'
import { deleteMessagesWithGeneratedMedia } from '@/lib/chat/history-deletion'

const MAX_BODY_BYTES = 16 * 1024
const MAX_MESSAGE_IDS = 100
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type MessageDeleteResult = Awaited<ReturnType<typeof deleteMessagesWithGeneratedMedia>>

export type MessageDeletionDependencies = {
  resolveAuth: () => Promise<AuthCtx>
  enforceRateLimit: (auth: AuthCtx, request: Request) => Promise<RequestRateGate>
  readBody: (request: Request, options: { maxBytes: number }) => Promise<unknown>
  deleteMessages: (userId: string, ids: string[]) => Promise<MessageDeleteResult>
}

const DEFAULT_DEPENDENCIES: MessageDeletionDependencies = {
  resolveAuth,
  enforceRateLimit: enforceRequestRateLimit,
  readBody: (request, options) => readJson(request, options),
  deleteMessages: deleteMessagesWithGeneratedMedia,
}

function errorResponse(request: Request, options: {
  status: number
  code: ApiErrorCode
  message: string
  retryable?: boolean
  retryAfter?: string | null
}): Response {
  return apiErrorResponseV1(request, {
    status: options.status,
    code: options.code,
    message: options.message,
    retryable: options.retryable ?? false,
    ...(options.retryAfter ? { headers: { 'Retry-After': options.retryAfter } } : {}),
  })
}

function rateLimitResponse(request: Request, response: Response): Response {
  const retryAfter = response.headers.get('Retry-After')
  return response.status === 429
    ? errorResponse(request, {
        status: 429,
        code: 'RATE_LIMITED',
        message: '请求过于频繁，请稍后再试',
        retryable: true,
        retryAfter,
      })
    : errorResponse(request, {
        status: 503,
        code: 'DEPENDENCY_UNAVAILABLE',
        message: '服务暂时不可用，请稍后再试',
        retryable: true,
        retryAfter,
      })
}

function parseMessageIds(body: unknown): string[] | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const ids = (body as { ids?: unknown }).ids
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_MESSAGE_IDS) return null
  return ids.every(id => typeof id === 'string' && UUID.test(id)) ? ids : null
}

export async function handleMessageDeletion(
  request: Request,
  dependencyOverrides: Partial<MessageDeletionDependencies> = {},
): Promise<Response> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides }
  const auth = await dependencies.resolveAuth()
  if (auth.authUnavailable) return errorResponse(request, {
    status: 503,
    code: 'AUTH_DEPENDENCY_UNAVAILABLE',
    message: '认证服务暂时不可用，请稍后再试',
    retryable: true,
    retryAfter: '5',
  })
  if (!auth.userId) return errorResponse(request, {
    status: 401,
    code: 'AUTH_REQUIRED',
    message: '请先登录',
  })

  const rate = await dependencies.enforceRateLimit(auth, request)
  if (rate.response) return rateLimitResponse(request, rate.response)

  let body: unknown
  try {
    body = await dependencies.readBody(request, { maxBytes: MAX_BODY_BYTES })
  } catch (error) {
    const payloadTooLarge = error instanceof RequestError && error.status === 413
    return errorResponse(request, {
      status: payloadTooLarge ? 413 : 400,
      code: payloadTooLarge ? 'PAYLOAD_TOO_LARGE' : 'INVALID_REQUEST',
      message: payloadTooLarge ? error.message : '删除请求无效',
    })
  }

  const ids = parseMessageIds(body)
  if (!ids) return errorResponse(request, {
    status: 400,
    code: 'INVALID_REQUEST',
    message: '删除请求无效',
  })

  const result = await dependencies.deleteMessages(auth.userId, ids)
  if (result.kind === 'deleted') {
    return Response.json({
      ok: true,
      deleted: result.messageIds.length,
      cleanupPending: result.cleanupPending,
    }, {
      headers: {
        'Cache-Control': 'no-store',
        'X-Request-Id': requestId(request),
      },
    })
  }
  if (result.kind === 'active_generation') return errorResponse(request, {
    status: 409,
    code: 'CONFLICT',
    message: '会话仍在生成，请先停止并等待终态确认',
    retryable: true,
    retryAfter: '1',
  })
  if (result.kind === 'not_found') return errorResponse(request, {
    status: 404,
    code: 'NOT_FOUND',
    message: '消息不存在',
  })
  return errorResponse(request, {
    status: 503,
    code: 'DEPENDENCY_UNAVAILABLE',
    message: '删除服务暂时不可用，请稍后再试',
    retryable: true,
    retryAfter: '2',
  })
}
