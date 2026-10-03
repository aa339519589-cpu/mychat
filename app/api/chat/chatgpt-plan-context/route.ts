import { NextRequest } from 'next/server'
import { enforceRequestRateLimit, resolveAuth } from '@/lib/api/guard'
import { readJson, requestErrorResponse } from '@/lib/api/request'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  preparePlanContextResponse,
  planResponse as response,
  validPlanUUID as validUUID,
  type PlanContextBody,
} from '@/lib/chat/chatgpt-plan-context'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: NextRequest): Promise<Response> {
  const auth = await resolveAuth(request)
  if (auth.authUnavailable) return response({ error: '认证服务暂时不可用' }, 503)
  if (!auth.userId || !auth.supabase) return response({ error: '请先登录 MyChat' }, 401)
  const rate = await enforceRequestRateLimit(auth, request)
  if (rate.response) return rate.response
  let body: PlanContextBody
  try { body = await readJson(request, { maxBytes: 2 * 1024 * 1024 }) as PlanContextBody }
  catch (error) { return requestErrorResponse(error) }

  if (!validUUID(body.conversationId) || !validUUID(body.userMessageId)
    || !validUUID(body.assistantMessageId) || typeof body.privateChat !== 'boolean') {
    return response({ error: 'ChatGPT 套餐对话上下文请求无效' }, 400)
  }
  const conversationId = body.conversationId.toLowerCase()
  const userMessageId = body.userMessageId.toLowerCase()
  const assistantMessageId = body.assistantMessageId.toLowerCase()
  const admin = createAdminClient()
  if (!admin) return response({ error: '对话数据库暂时不可用' }, 503)
  const context = await preparePlanContextResponse({
    client: admin,
    userId: auth.userId,
    conversationId,
    userMessageId,
    assistantMessageId,
    body,
    signal: request.signal,
  })
  if (context instanceof Response) return context
  return response(context)
}
