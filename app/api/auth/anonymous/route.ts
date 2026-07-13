import { NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { log } from '@/lib/logger'
import { checkRateLimit } from '@/lib/rate-limit'
import { clientAddress } from '@/lib/api/request'

export async function POST(req: NextRequest) {
  try {
    const address = clientAddress(req)
    const rate = await checkRateLimit(`anonymous-signin:${address}`, { max: 5, windowMs: 60 * 60_000 })
    if (rate.unavailable) {
      return Response.json(
        { error: '服务暂时不可用，请稍后再试' },
        { status: 503, headers: { 'Retry-After': String(rate.retryAfterSeconds) } },
      )
    }
    if (!rate.allowed) {
      return Response.json(
        { error: '游客登录请求过于频繁，请稍后再试' },
        { status: 429, headers: { 'Retry-After': String(rate.retryAfterSeconds) } },
      )
    }
    const supabase = await createClient()
    const { data, error } = await supabase.auth.signInAnonymously()

    if (error || !data.user) {
      log.error('anonymousAuth', 'Failed to sign in anonymously', error)
      return new Response(JSON.stringify({ error: '游客登录失败' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
    }

    log.info('anonymousAuth', 'Anonymous user created', { userId: data.user.id })
    return new Response(JSON.stringify({ success: true, user: { id: data.user.id } }), { headers: { 'Content-Type': 'application/json' } })
  } catch (e) {
    log.error('anonymousAuth', 'Exception during anonymous login', e)
    return new Response(JSON.stringify({ error: '服务错误' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
}
