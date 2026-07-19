import { createAdminClient } from '@/lib/supabase/admin'
import { createClient as createSessionClient } from '@/lib/supabase/server'
import {
  MAX_CUSTOM_SYSTEM_PROMPT_CHARS,
  normalizeCustomSystemPrompt,
} from '@/lib/user-system-prompt'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

function response(body: object, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  })
}

async function authenticatedUserId(): Promise<string | null> {
  const session = await createSessionClient()
  const { data, error } = await session.auth.getUser()
  if (error || !data.user) return null
  return data.user.id
}

export async function GET(): Promise<Response> {
  const userId = await authenticatedUserId()
  if (!userId) return response({ error: '请先登录后再读取系统提示词' }, 401)

  const admin = createAdminClient()
  if (!admin) return response({ error: '系统提示词服务暂时不可用' }, 503)

  const { data, error } = await admin
    .from('profiles')
    .select('custom_system_prompt')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) {
    console.error('custom system prompt read failed', { code: error.code })
    return response({ error: '系统提示词加载失败，请稍后重试' }, 500)
  }

  return response({ prompt: normalizeCustomSystemPrompt(data?.custom_system_prompt) })
}

export async function PUT(request: Request): Promise<Response> {
  const userId = await authenticatedUserId()
  if (!userId) return response({ error: '请先登录后再保存' }, 401)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return response({ error: '系统提示词内容格式无效' }, 400)
  }

  const prompt = (body as { prompt?: unknown } | null)?.prompt
  if (typeof prompt !== 'string') {
    return response({ error: '系统提示词内容格式无效' }, 400)
  }
  if (prompt.trim().length > MAX_CUSTOM_SYSTEM_PROMPT_CHARS) {
    return response({
      error: `系统提示词最多 ${MAX_CUSTOM_SYSTEM_PROMPT_CHARS.toLocaleString()} 字`,
    }, 400)
  }

  const admin = createAdminClient()
  if (!admin) return response({ error: '系统提示词服务暂时不可用' }, 503)

  const normalized = normalizeCustomSystemPrompt(prompt)
  const { data, error } = await admin
    .from('profiles')
    .upsert({ user_id: userId, custom_system_prompt: normalized }, { onConflict: 'user_id' })
    .select('custom_system_prompt')
    .single()

  if (error || normalizeCustomSystemPrompt(data?.custom_system_prompt) !== normalized) {
    console.error('custom system prompt save failed', { code: error?.code ?? 'readback-mismatch' })
    return response({ error: '系统提示词保存失败，请稍后重试' }, 500)
  }

  return response({ prompt: normalized })
}
