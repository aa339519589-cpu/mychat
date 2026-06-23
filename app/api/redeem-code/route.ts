import { NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { log } from '@/lib/logger'
import { validate } from '@/lib/validation'

export async function POST(req: NextRequest) {
  let body: any = {}
  try {
    body = await req.json()
  } catch (e) {
    log.error('redeemCode', 'Invalid JSON in request body', e)
    return new Response(JSON.stringify({ error: '请求体格式错误' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
  }

  try {
    const code = validate.string(body.code, 'code', { minLength: 1 })
    log.info('redeemCode', 'Attempting to redeem code', { code: code.substring(0, 6) + '...' })

    const supabase = await createClient()
    const { data: user } = await supabase.auth.getUser()
    if (!user.user?.id) {
      log.warn('redeemCode', 'Not logged in')
      return new Response(JSON.stringify({ error: '未登录' }), { status: 401, headers: { 'Content-Type': 'application/json' } })
    }

    // 查找邀请码
    const { data: codeRecord, error: selectErr } = await supabase
      .from('invitation_codes')
      .select('id, tokens, used_by')
      .eq('code', code.trim())
      .maybeSingle()

    if (selectErr || !codeRecord) {
      log.warn('redeemCode', 'Code not found or invalid', { error: selectErr })
      return new Response(JSON.stringify({ error: '邀请码无效' }), { status: 404, headers: { 'Content-Type': 'application/json' } })
    }

    if (codeRecord.used_by) {
      log.warn('redeemCode', 'Code already used', { codeId: codeRecord.id, usedBy: codeRecord.used_by })
      return new Response(JSON.stringify({ error: '邀请码已被使用' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
    }

    // 标记邀请码为已使用
    const { error: updateCodeErr } = await supabase
      .from('invitation_codes')
      .update({ used_by: user.user.id, used_at: new Date().toISOString() })
      .eq('id', codeRecord.id)

    if (updateCodeErr) {
      log.error('redeemCode', 'Failed to mark code as used', updateCodeErr)
      return new Response(JSON.stringify({ error: '兑换失败' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
    }

    // 增加用户余额
    const { data: profile } = await supabase
      .from('profiles')
      .select('balance')
      .eq('user_id', user.user.id)
      .maybeSingle()

    const newBalance = ((profile?.balance as number) ?? 0) + codeRecord.tokens

    const { error: updateBalanceErr } = await supabase
      .from('profiles')
      .upsert({ user_id: user.user.id, balance: newBalance }, { onConflict: 'user_id' })

    if (updateBalanceErr) {
      log.error('redeemCode', 'Failed to update balance', updateBalanceErr)
      return new Response(JSON.stringify({ error: '余额更新失败' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
    }

    log.info('redeemCode', 'Code redeemed successfully', { userId: user.user.id, tokens: codeRecord.tokens, newBalance })
    return new Response(JSON.stringify({ success: true, tokensAdded: codeRecord.tokens, newBalance }), { headers: { 'Content-Type': 'application/json' } })
  } catch (e) {
    log.error('redeemCode', 'Exception during code redemption', e)
    return new Response(JSON.stringify({ error: '服务错误' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
}
