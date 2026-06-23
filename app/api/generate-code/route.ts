import { NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { log } from '@/lib/logger'
import { validate } from '@/lib/validation'
import { generateInvitationCode } from '@/lib/invitation-code-gen'

export async function POST(req: NextRequest) {
  let body: any = {}
  try {
    body = await req.json()
  } catch (e) {
    log.error('generateCode', 'Invalid JSON in request body', e)
    return new Response(JSON.stringify({ error: '请求体格式错误' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
  }

  try {
    const count = validate.number(body.count ?? 1, 'count', { min: 1, max: 100, isInteger: true })

    const supabase = await createClient()
    const { data: user } = await supabase.auth.getUser()
    if (!user.user?.id) {
      log.warn('generateCode', 'Not logged in')
      return new Response(JSON.stringify({ error: '未登录' }), { status: 401, headers: { 'Content-Type': 'application/json' } })
    }

    log.info('generateCode', 'Generating invitation codes', { userId: user.user.id, count })

    const codes = Array.from({ length: count }, () => ({
      code: generateInvitationCode(),
      tokens: 20_000_000,
      created_by: user.user.id,
    }))

    const { data, error } = await supabase
      .from('invitation_codes')
      .insert(codes)
      .select('code')

    if (error) {
      log.error('generateCode', 'Failed to insert codes', error)
      return new Response(JSON.stringify({ error: '生成失败' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
    }

    const generatedCodes = (data ?? []).map(r => r.code)
    log.info('generateCode', 'Codes generated successfully', { count: generatedCodes.length, userId: user.user.id })

    return new Response(JSON.stringify({
      success: true,
      codes: generatedCodes,
      tokens_per_code: 20_000_000,
    }), { headers: { 'Content-Type': 'application/json' } })
  } catch (e) {
    if (e instanceof Error && e.name === 'ValidationError') {
      log.warn('generateCode', 'Validation error', e)
      return new Response(JSON.stringify({ error: e.message }), { status: 400, headers: { 'Content-Type': 'application/json' } })
    }
    log.error('generateCode', 'Exception during code generation', e)
    return new Response(JSON.stringify({ error: '服务错误' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
}
