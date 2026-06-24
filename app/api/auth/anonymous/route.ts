import { NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { log } from '@/lib/logger'

export async function POST(_req: NextRequest) {
  try {
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
