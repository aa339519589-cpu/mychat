import { resolveAuth } from '@/lib/api/guard'
import { createAdminClient } from '@/lib/supabase/admin'
import { toJson } from '@/lib/supabase/json'
import { normalizeTokenUsage, type TokenUsage } from '@/lib/token-usage'
import { isRecord } from '@/lib/unknown-value'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type TokenUsageIdentity = {
  conversationId: string
  messageId: string
  generationId: string
}

type AdminClient = NonNullable<ReturnType<typeof createAdminClient>>
type UsageLookup = { tokenUsage: TokenUsage } | { response: Response }

function json(error: string, status: number): Response {
  return Response.json({ error }, { status, headers: { 'Cache-Control': 'private, no-store' } })
}

function identity(value: unknown): TokenUsageIdentity | null {
  if (!isRecord(value)) return null
  const conversationId = value.conversationId
  const messageId = value.messageId
  const generationId = value.generationId
  if (typeof conversationId !== 'string' || !UUID.test(conversationId)
    || typeof messageId !== 'string' || !UUID.test(messageId)
    || typeof generationId !== 'string' || !UUID.test(generationId)) return null
  return { conversationId, messageId, generationId }
}

function messageImages(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value
  if (Array.isArray(value)) return { refs: value.filter(item => typeof item === 'string') }
  return {}
}

function adminClient(): AdminClient | null {
  try {
    return createAdminClient()
  } catch {
    return null
  }
}

async function completedUsage(
  admin: AdminClient,
  userId: string,
  input: TokenUsageIdentity,
): Promise<UsageLookup> {
  const { data: job, error } = await admin
    .from('jobs')
    .select('id, principal_id, status, subject, result')
    .eq('id', input.generationId)
    .eq('principal_id', userId)
    .maybeSingle()
  if (error) return { response: json('Token 数据读取失败', 503) }
  const validJob = job?.status === 'completed'
    && isRecord(job.subject)
    && job.subject.conversationId === input.conversationId
    && job.subject.assistantMessageId === input.messageId
  if (!validJob) return { response: json('Token 数据不存在', 404) }
  const result = isRecord(job.result) ? job.result : null
  const tokenUsage = normalizeTokenUsage(result?.tokenUsage)
  return tokenUsage
    ? { tokenUsage }
    : { response: json('模型未返回拆分 Token 数据', 409) }
}

async function persistUsage(
  admin: AdminClient,
  userId: string,
  input: TokenUsageIdentity,
  tokenUsage: TokenUsage,
): Promise<Response | null> {
  const { data: message, error } = await admin
    .from('messages')
    .select('id, role, images')
    .eq('id', input.messageId)
    .eq('user_id', userId)
    .eq('conversation_id', input.conversationId)
    .eq('generation_id', input.generationId)
    .maybeSingle()
  if (error) return json('消息数据读取失败', 503)
  if (!message || message.role !== 'assistant') return json('消息不存在', 404)
  const images = { ...messageImages(message.images), token_usage: tokenUsage }
  const update = await admin.from('messages').update({
    images: toJson(images),
    updated_at: new Date().toISOString(),
  }).eq('id', input.messageId)
    .eq('user_id', userId)
    .eq('conversation_id', input.conversationId)
    .eq('generation_id', input.generationId)
  return update.error ? json('Token 数据保存失败', 503) : null
}

export async function POST(request: Request): Promise<Response> {
  const auth = await resolveAuth(request)
  if (auth.authUnavailable) return json('认证服务暂时不可用', 503)
  if (!auth.userId || auth.isOwner !== true) return json('未找到', 404)
  const input = identity(await request.json().catch(() => null))
  if (!input) return json('请求格式无效', 400)
  const admin = adminClient()
  if (!admin) return json('数据服务暂时不可用', 503)
  const lookup = await completedUsage(admin, auth.userId, input)
  if ('response' in lookup) return lookup.response
  const persistenceError = await persistUsage(admin, auth.userId, input, lookup.tokenUsage)
  if (persistenceError) return persistenceError
  return Response.json({ tokenUsage: lookup.tokenUsage }, {
    headers: { 'Cache-Control': 'private, no-store' },
  })
}
