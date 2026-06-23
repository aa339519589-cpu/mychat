import { NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function POST(req: NextRequest) {
  const { code } = await req.json()
  if (!code || typeof code !== 'string') {
    return new Response(JSON.stringify({ error: '邀请码不能为空' }), { status: 400 })
  }

  try {
    const supabase = await createClient()
    const { data: user } = await supabase.auth.getUser()
    if (!user.user?.id) {
      return new Response(JSON.stringify({ error: '未登录' }), { status: 401 })
    }

    // 查找邀请码
    const { data: codeRecord, error: selectErr } = await supabase
      .from('invitation_codes')
      .select('id, tokens, used_by')
      .eq('code', code.trim())
      .maybeSingle()

    if (selectErr || !codeRecord) {
      return new Response(JSON.stringify({ error: '邀请码无效' }), { status: 404 })
    }

    if (codeRecord.used_by) {
      return new Response(JSON.stringify({ error: '邀请码已被使用' }), { status: 400 })
    }

    // 标记邀请码为已使用
    const { error: updateCodeErr } = await supabase
      .from('invitation_codes')
      .update({ used_by: user.user.id, used_at: new Date().toISOString() })
      .eq('id', codeRecord.id)

    if (updateCodeErr) {
      return new Response(JSON.stringify({ error: '兑换失败' }), { status: 500 })
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
      console.error('[redeem-code] 更新余额失败:', updateBalanceErr)
      return new Response(JSON.stringify({ error: '余额更新失败' }), { status: 500 })
    }

    return new Response(JSON.stringify({ success: true, tokensAdded: codeRecord.tokens, newBalance }))
  } catch (e) {
    console.error('[redeem-code]', e)
    return new Response(JSON.stringify({ error: '服务错误' }), { status: 500 })
  }
}
