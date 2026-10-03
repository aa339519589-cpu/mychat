import { NextRequest } from 'next/server'
import { apiErrorResponseV1 } from '@/lib/api/errors'
import { enforceRequestRateLimit, resolveAuth } from '@/lib/api/guard'
import { readJson, RequestError } from '@/lib/api/request'
import { createAdminClient } from '@/lib/supabase/admin'
import type { SupabaseClient } from '@/lib/supabase/types'
import {
  ChatGPTPlanHistoryInputError,
  persistChatGPTPlanHistoryTurn,
  validateChatGPTPlanHistoryTurn,
} from '@/lib/chat/chatgpt-plan-history'

export const runtime = 'nodejs'

type ChatGPTPlanHistoryDependencies = {
  resolveAuth: typeof resolveAuth
  enforceRequestRateLimit: typeof enforceRequestRateLimit
  createAdminClient: () => SupabaseClient | null
}

export function createChatGPTPlanHistoryPostHandler(
  dependencies: ChatGPTPlanHistoryDependencies = { resolveAuth, enforceRequestRateLimit, createAdminClient },
) {
  return async function handleChatGPTPlanHistoryPost(request: NextRequest): Promise<Response> {
    const auth = await dependencies.resolveAuth(request)
    if (auth.authUnavailable) return apiErrorResponseV1(request, {
      status: 503, code: 'AUTH_DEPENDENCY_UNAVAILABLE', message: '认证服务暂时不可用', retryable: true,
      headers: { 'Retry-After': '5' },
    })
    const rate = await dependencies.enforceRequestRateLimit(auth, request)
    if (rate.response) return rate.response
    if (!auth.supabase || !auth.userId) return apiErrorResponseV1(request, {
      status: 401, code: 'AUTH_REQUIRED', message: '请先登录 MyChat', retryable: false,
    })

    let input
    try {
      input = validateChatGPTPlanHistoryTurn(await readJson(request, { maxBytes: 34 * 1024 * 1024 }))
    } catch (error) {
      const status = error instanceof RequestError ? error.status : 400
      return apiErrorResponseV1(request, {
        status,
        code: 'INVALID_REQUEST',
        message: error instanceof Error ? error.message : '请求内容无效',
        retryable: false,
      })
    }

    const admin = dependencies.createAdminClient()
    if (!admin) return apiErrorResponseV1(request, {
      status: 503, code: 'DEPENDENCY_UNAVAILABLE', message: '历史记录暂时无法保存', retryable: true,
      headers: { 'Retry-After': '5' },
    })

    try {
      const result = await persistChatGPTPlanHistoryTurn(admin, auth.userId, input)
      if (result.kind === 'persisted') {
        return Response.json({ schemaVersion: 1, saved: true }, {
          headers: { 'Cache-Control': 'no-store' },
        })
      }
      if (result.kind === 'not_found') return apiErrorResponseV1(request, {
        status: 404, code: 'NOT_FOUND', message: '对话或 Project 不存在', retryable: false,
      })
      if (result.kind === 'conflict') return apiErrorResponseV1(request, {
        status: 409, code: 'CONFLICT', message: '消息标识已用于其他内容，未覆盖历史记录', retryable: false,
      })
      return apiErrorResponseV1(request, {
        status: 503, code: 'DEPENDENCY_UNAVAILABLE', message: '历史记录暂时无法保存', retryable: true,
        headers: { 'Retry-After': '5' },
      })
    } catch (error) {
      return apiErrorResponseV1(request, {
        status: 503,
        code: 'DEPENDENCY_UNAVAILABLE',
        message: error instanceof ChatGPTPlanHistoryInputError ? error.message : '历史记录暂时无法保存',
        retryable: true,
        headers: { 'Retry-After': '5' },
      })
    }
  }
}

export const POST = createChatGPTPlanHistoryPostHandler()
