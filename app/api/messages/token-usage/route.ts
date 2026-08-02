import { resolveAuth } from '@/lib/api/guard'
import { createAdminClient } from '@/lib/supabase/admin'
import { toJson } from '@/lib/supabase/json'
import { normalizeTokenUsage } from '@/lib/token-usage'
import { isRecord } from '@/lib/unknown-value'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type TokenUsageIdentity = {
  conversationId: string
  messageId: string
  generationId: string
}

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

export async function POST(request: Request): Promise<Response> {
  const auth = await resolveAuth(request)
  if (auth.authUnavailable) return json('认证服务暂时不可用', 503)
  if (!auth.userId || auth.isOwner !== true) return json('未找到', 404)

  const input = identity(await request.json().catch(() => null))
  if (!input) return json('请求格式无效', 400)

  let admin: ReturnType<typeof createAdminClient>
  try {
    admin = createAdminClient()
  } catch {
    return json('数据服务暂时不可用', 503)
  }
  if (!admin) return json('数据服务暂时不可用', 503)

  const { data: job, error: jobError } = await admin
    .from('jobs')
    .select('id, principal_id, status, subject, result')
    .eq('id', input.generationId)
    .eq('principal_id', auth.userId)
    .maybeSingle()
  if (jobError) return json('Token 数据读取失败', 503)
  if (!job || job.status !== 'completed' || !isRecord(job.subject)
    || job.subject.conversationId !== input.conversationId
    || job.subject.assistantMessageId !== input.messageId) return json('Token 数据不存在', 404)

  const result = isRecord(job.result) ? job.result : null
  const tokenUsage = normalizeTokenUsage(result?.tokenUsage)
  if (!tokenUsage) return json('模型未返回拆分 Token 数据', 409)

  const { data: message, error: messageError } = await admin
    .from('messages')
    .select('id, user_id, conversation_id, role, generation_id, images')
    .eq('id', input.messageId)
    .eq('user_id', auth.userId)
    .eq('conversation_id', input.conversationId)
    .eq('generation_id', input.generationId)
    .maybeSingle()
  if (messageError) return json('消息数据读取失败', 503)
  if (!message || message.role !== 'assistant') return json('消息不存在', 404)

  const images = { ...messageImages(message.images), token_usage: tokenUsage }
  const { error: updateError } = await admin
    .from('messages')
    .update({ images: toJson(images), updated_at: new Date().toISOString() })
    .eq('id', input.messageId)
    .eq('user_id', auth.userId)
    .eq('conversation_id', input.conversationId)
    .eq('generation_id', input.generationId)
  if (updateError) return json('Token 数据保存失败', 503)

  return Response.json({ tokenUsage }, {
    headers: { 'Cache-Control': 'private, no-store' },
  })
}
