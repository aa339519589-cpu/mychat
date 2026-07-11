import { NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { log } from '@/lib/logger'
import { validate } from '@/lib/validation'
import { readJson, requestErrorResponse } from '@/lib/api/request'
import { checkRateLimit } from '@/lib/rate-limit'

export async function POST(req: NextRequest) {
  let body: any = {}
  try {
    body = await readJson(req, { maxBytes: 16 * 1024 })
  } catch (e) {
    log.error('redeemCode', 'Invalid JSON in request body', e)
    return requestErrorResponse(e)
  }

  try {
    const code = validate.string(body.code, 'code', { minLength: 8, maxLength: 128 })
    log.info('redeemCode', 'Attempting to redeem code', { code: code.substring(0, 6) + '...' })

    const supabase = await createClient()
    const { data: user } = await supabase.auth.getUser()
    if (!user.user?.id) {
      log.warn('redeemCode', 'Not logged in')
      return new Response(JSON.stringify({ error: '未登录' }), { status: 401, headers: { 'Content-Type': 'application/json' } })
    }
    const rate = checkRateLimit(`redeem:${user.user.id}`, { max: 10, windowMs: 60 * 60_000 })
    if (!rate.allowed) {
      return Response.json({ error: '兑换尝试过于频繁，请稍后再试' }, {
        status: 429,
        headers: { 'Retry-After': String(rate.retryAfterSeconds) },
      })
    }

    const { data, error } = await supabase.rpc('redeem_invitation_code', { input_code: code.trim() })
    const result = Array.isArray(data) ? data[0] : data
    if (error || !result) {
      const invalid = error?.message?.includes('invalid_or_used')
      log.warn('redeemCode', 'Atomic redemption rejected', { userId: user.user.id, invalid, code: error?.code })
      return Response.json({ error: invalid ? '邀请码无效或已被使用' : '兑换失败' }, { status: invalid ? 400 : 500 })
    }
    const tokensAdded = Number(result.tokens_added ?? 0)
    const newBalance = Number(result.new_balance ?? 0)
    log.info('redeemCode', 'Code redeemed successfully', { userId: user.user.id, tokens: tokensAdded, newBalance })
    return Response.json({ success: true, tokensAdded, newBalance })
  } catch (e) {
    log.error('redeemCode', 'Exception during code redemption', e)
    return new Response(JSON.stringify({ error: '服务错误' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
}
