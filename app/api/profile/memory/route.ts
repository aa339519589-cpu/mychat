import { createAdminClient } from '@/lib/supabase/admin'
import { createClient as createSessionClient } from '@/lib/supabase/server'

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
  if (!userId) return response({ error: '请先登录后再读取记忆设置' }, 401)

  const admin = createAdminClient()
  if (!admin) return response({ error: '记忆设置服务暂时不可用' }, 503)

  const { data, error } = await admin
    .from('profiles')
    .select('memory_enabled')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) return response({ error: '记忆设置读取失败' }, 500)
  return response({ enabled: data?.memory_enabled !== false })
}

export async function PUT(request: Request): Promise<Response> {
  const userId = await authenticatedUserId()
  if (!userId) return response({ error: '请先登录后再保存记忆设置' }, 401)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return response({ error: '记忆设置格式无效' }, 400)
  }

  const enabled = (body as { enabled?: unknown } | null)?.enabled
  if (typeof enabled !== 'boolean') return response({ error: '记忆设置格式无效' }, 400)

  const admin = createAdminClient()
  if (!admin) return response({ error: '记忆设置服务暂时不可用' }, 503)

  const { data, error } = await admin
    .from('profiles')
    .upsert({ user_id: userId, memory_enabled: enabled }, { onConflict: 'user_id' })
    .select('memory_enabled')
    .single()

  if (error || data?.memory_enabled !== enabled) {
    console.error('memory setting save failed', { code: error?.code ?? 'readback-mismatch' })
    return response({ error: '记忆设置保存失败' }, 500)
  }

  return response({ enabled })
}
