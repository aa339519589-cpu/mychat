import { NextRequest } from 'next/server'
import { apiErrorResponseV1 } from '@/lib/api/errors'
import { resolveAuth } from '@/lib/api/guard'
import { readLatestOwnedConversationJob } from '@/lib/jobs/read-model'
import { log } from '@/lib/logger'
import { createAdminClient } from '@/lib/supabase/admin'
import { isUuid } from '@/lib/validation'

async function readConversationGeneration(
  client: NonNullable<Awaited<ReturnType<typeof resolveAuth>>['supabase']>,
  userId: string,
  conversationId: string,
  signal: AbortSignal,
) {
  const primary = await readLatestOwnedConversationJob(client, userId, conversationId, signal)
  if (primary.ok) return primary

  // Browser-session RLS or a transient PostgREST read failure must not make the
  // composer unusable. Retry once through the server-only client while still
  // filtering by the authenticated principal and conversation id.
  const admin = createAdminClient()
  if (!admin) return primary
  const fallback = await readLatestOwnedConversationJob(admin, userId, conversationId, signal)
  return fallback.ok ? fallback : primary
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ conversationId: string }> },
) {
  const auth = await resolveAuth()
  if (auth.authUnavailable) return apiErrorResponseV1(request, {
    status: 503,
    code: 'AUTH_DEPENDENCY_UNAVAILABLE',
    message: '认证服务暂时不可用',
    retryable: true,
    headers: { 'Retry-After': '5' },
  })
  if (!auth.supabase || !auth.userId) return apiErrorResponseV1(request, {
    status: 401, code: 'AUTH_REQUIRED', message: '请先登录', retryable: false,
  })
  const { conversationId } = await context.params
  if (!isUuid(conversationId)) return apiErrorResponseV1(request, {
    status: 400, code: 'INVALID_REQUEST', message: 'conversationId 无效', retryable: false,
  })
  const result = await readConversationGeneration(
    auth.supabase,
    auth.userId,
    conversationId,
    request.signal,
  )
  if (!result.ok) {
    // This endpoint is a recovery/read hint, not the authority that admits a
    // new turn. The enqueue RPC still fences duplicate active generations, so
    // a status-read outage should fail open instead of blocking every message.
    log.warn('jobs', 'Conversation generation status read degraded', {
      conversationId,
      kind: result.kind,
    })
    return Response.json({
      job: null,
      streamUrl: null,
      degraded: true,
    }, {
      headers: {
        'Cache-Control': 'no-store',
        'X-MyChat-Generation-Status': 'degraded',
      },
    })
  }
  return Response.json({
    job: result.value,
    streamUrl: result.value ? `/api/v1/jobs/${result.value.id}/events?from_seq=0` : null,
    degraded: false,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
