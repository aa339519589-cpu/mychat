import { NextRequest } from 'next/server'
import { apiErrorResponseV1 } from '@/lib/api/errors'
import { resolveAuth, type SupabaseServer } from '@/lib/api/guard'
import { readLatestOwnedConversationJob } from '@/lib/jobs/read-model'
import { log } from '@/lib/logger'
import { createAdminClient } from '@/lib/supabase/admin'
import { isUuid } from '@/lib/validation'

function degradedGenerationStatus(reason: string) {
  log.warn('jobs', 'Conversation generation status degraded before read', { reason })
  return Response.json({
    job: null,
    streamUrl: null,
    degraded: true,
  }, {
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      Pragma: 'no-cache',
      Expires: '0',
      Vary: 'Cookie, Authorization',
      'X-MyChat-Generation-Status': 'degraded',
    },
  })
}

async function readConversationGeneration(
  client: SupabaseServer,
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

  // This endpoint only restores an already-running generation. A stale or
  // device-specific browser session must never lock the composer. Returning an
  // empty degraded snapshot is safe because enqueue remains authenticated and
  // database-fenced by the write endpoint.
  if (auth.authUnavailable) return degradedGenerationStatus('auth_unavailable')
  if (!auth.supabase || !auth.userId) return degradedGenerationStatus('auth_missing')

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
    log.warn('jobs', 'Conversation generation status read degraded', {
      conversationId,
      kind: result.kind,
    })
    return degradedGenerationStatus(result.kind)
  }
  return Response.json({
    job: result.value,
    streamUrl: result.value ? `/api/v1/jobs/${result.value.id}/events?from_seq=0` : null,
    degraded: false,
  }, {
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      Pragma: 'no-cache',
      Expires: '0',
      Vary: 'Cookie, Authorization',
      'X-MyChat-Generation-Status': 'ok',
    },
  })
}
