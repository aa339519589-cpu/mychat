import { createHash } from 'node:crypto'
import { NextRequest } from 'next/server'
import { clientAddress, readJson, RequestError } from '@/lib/api/request'
import { log } from '@/lib/logger'
import { checkRateLimit, type RateLimitResult } from '@/lib/rate-limit'
import { createClient } from '@/lib/supabase/server'

type EmailCommand = {
  mode: 'signin' | 'signup'
  email: string
  password: string
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function command(value: unknown): EmailCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RequestError(400, '登录参数无效')
  }
  const input = value as Record<string, unknown>
  const mode = input.mode
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : ''
  const password = typeof input.password === 'string' ? input.password : ''
  if ((mode !== 'signin' && mode !== 'signup')
    || email.length > 254 || !EMAIL.test(email)
    || password.length < 6 || password.length > 256) {
    throw new RequestError(400, '邮箱或密码格式无效')
  }
  return { mode, email, password }
}

function limited(rate: RateLimitResult): Response | null {
  if (rate.unavailable) return Response.json(
    { error: '登录服务暂时不可用，请稍后再试' },
    { status: 503, headers: { 'Retry-After': String(rate.retryAfterSeconds) } },
  )
  if (!rate.allowed) return Response.json(
    { error: '操作太频繁，请稍后再试' },
    { status: 429, headers: { 'Retry-After': String(rate.retryAfterSeconds) } },
  )
  return null
}

export async function POST(request: NextRequest): Promise<Response> {
  let input: EmailCommand
  try {
    input = command(await readJson(request, { maxBytes: 8 * 1024 }))
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : '登录参数无效' },
      { status: error instanceof RequestError ? error.status : 400 },
    )
  }

  const address = clientAddress(request)
  const identity = createHash('sha256').update(input.email).digest('hex').slice(0, 32)
  const [addressRate, identityRate] = await Promise.all([
    checkRateLimit(`email-auth:${input.mode}:ip:${address}`, {
      max: input.mode === 'signup' ? 5 : 30,
      windowMs: 60 * 60_000,
    }),
    checkRateLimit(`email-auth:${input.mode}:identity:${identity}`, {
      max: input.mode === 'signup' ? 3 : 10,
      windowMs: 15 * 60_000,
    }),
  ])
  const rateResponse = limited(addressRate) ?? limited(identityRate)
  if (rateResponse) return rateResponse

  try {
    const supabase = await createClient()
    if (input.mode === 'signup') {
      const { data, error } = await supabase.auth.signUp({
        email: input.email,
        password: input.password,
      })
      if (error) {
        log.warn('emailAuth', 'Email signup rejected', { status: error.status ?? null })
        return Response.json({ error: '暂时无法注册，请稍后重试' }, { status: 400 })
      }
      return Response.json({ success: true, requiresConfirmation: !data.session })
    }

    const { data, error } = await supabase.auth.signInWithPassword({
      email: input.email,
      password: input.password,
    })
    if (error || !data.session) {
      log.warn('emailAuth', 'Email signin rejected', { status: error?.status ?? null })
      return Response.json({ error: '邮箱或密码不正确' }, { status: 401 })
    }
    return Response.json({ success: true, requiresConfirmation: false })
  } catch (error) {
    log.error('emailAuth', 'Email authentication dependency failed', {
      name: error instanceof Error ? error.name : 'unknown',
    })
    return Response.json(
      { error: '登录服务暂时不可用，请稍后再试' },
      { status: 503, headers: { 'Retry-After': '5' } },
    )
  }
}
