import { NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'

function generateCode(length = 16): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let code = ''
  for (let i = 0; i < length; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return code
}

export async function POST(req: NextRequest) {
  const { count = 1 } = await req.json()
  if (typeof count !== 'number' || count < 1 || count > 100) {
    return new Response(JSON.stringify({ error: '数量需要在 1-100 之间' }), { status: 400 })
  }

  try {
    const supabase = await createClient()
    const { data: user } = await supabase.auth.getUser()
    if (!user.user?.id) {
      return new Response(JSON.stringify({ error: '未登录' }), { status: 401 })
    }

    const codes = Array.from({ length: count }, () => ({
      code: generateCode(),
      tokens: 20_000_000,
      created_by: user.user.id,
    }))

    const { data, error } = await supabase
      .from('invitation_codes')
      .insert(codes)
      .select('code')

    if (error) {
      console.error('[generate-code]', error)
      return new Response(JSON.stringify({ error: '生成失败' }), { status: 500 })
    }

    return new Response(JSON.stringify({
      success: true,
      codes: (data ?? []).map(r => r.code),
      tokens_per_code: 20_000_000,
    }))
  } catch (e) {
    console.error('[generate-code]', e)
    return new Response(JSON.stringify({ error: '服务错误' }), { status: 500 })
  }
}
