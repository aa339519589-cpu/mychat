// Route 守卫层：把流式 route 的「鉴权 + 限流 + 额度」前导逻辑收敛到一处。
// 大请求可先单独执行 enforceRequestRateLimit，再在解析 body 后执行 enforceQuotaLimit。
import { createClient } from '@/lib/supabase/server'
import { checkRateLimit } from '@/lib/rate-limit'
import { checkQuotaExceeded } from '@/lib/quota'
import { log } from '@/lib/logger'
import { clientAddress, requestId } from '@/lib/api/request'
import { isAuthDependencyUnavailable } from '@/lib/api/auth-error'

export type SupabaseServer = Awaited<ReturnType<typeof createClient>>
export type AuthCtx = {
  supabase: SupabaseServer | null
  userId: string | null
  isAnonymous: boolean
  authUnavailable?: boolean
}

function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } })
}

// A missing session is a valid anonymous request. An authentication dependency
// exception is different: mark it unavailable so protected traffic fails closed.
export async function resolveAuth(): Promise<AuthCtx> {
  try {
    const supabase = await createClient()
    const { data, error } = await supabase.auth.getUser()
    if (isAuthDependencyUnavailable(error)) {
      log.error('auth', 'Authentication dependency returned an error', {
        name: error?.name ?? 'unknown',
        status: error?.status,
      })
      return { supabase: null, userId: null, isAnonymous: true, authUnavailable: true }
    }
    return {
      supabase,
      userId: data.user?.id ?? null,
      isAnonymous: data.user?.is_anonymous === true,
    }
  } catch (error) {
    log.error('auth', 'Authentication dependency unavailable', error)
    return { supabase: null, userId: null, isAnonymous: true, authUnavailable: true }
  }
}

// 读用户的记忆总开关（缺省视为开启）。
export async function getMemoryEnabled(auth: AuthCtx): Promise<boolean> {
  const { supabase, userId } = auth
  if (!supabase || !userId) return true
  try {
    const { data } = await supabase.from('profiles').select('memory_enabled').eq('user_id', userId).maybeSingle()
    return data ? data.memory_enabled !== false : true
  } catch {
    return true
  }
}

export type LimitGate =
  | { response: Response; usingBalance?: undefined }
  | { response?: undefined; usingBalance: boolean }

export type RequestRateGate =
  | { response: Response }
  | { response?: undefined }

type GuardDependencies = {
  rateLimit: typeof checkRateLimit
  quotaCheck: typeof checkQuotaExceeded
}

const DEFAULT_GUARD_DEPENDENCIES: GuardDependencies = {
  rateLimit: checkRateLimit,
  quotaCheck: checkQuotaExceeded,
}

/** Consume the distributed request budget before a route allocates a large body. */
export async function enforceRequestRateLimit(
  auth: AuthCtx,
  request?: Request,
  dependencyOverrides: Partial<GuardDependencies> = {},
): Promise<RequestRateGate> {
  const { userId, isAnonymous } = auth
  const address = request ? clientAddress(request) : 'unknown'
  const traceId = request ? requestId(request) : undefined
  if (auth.authUnavailable) {
    log.error('auth', 'Authentication gate failed closed', { requestId: traceId })
    const response = json({ error: '认证服务暂时不可用，请稍后再试' }, 503)
    response.headers.set('Retry-After', '5')
    return { response }
  }
  const rateKey = userId
    ? `${isAnonymous ? 'anonymous-user' : 'user'}:${userId}`
    : `anonymous-address:${address}`
  const rate = await (dependencyOverrides.rateLimit ?? DEFAULT_GUARD_DEPENDENCIES.rateLimit)(rateKey, {
    max: userId && !isAnonymous ? 30 : 10,
    windowMs: 60_000,
  })
  if (rate.unavailable) {
    log.error('rateLimit', 'Rate limit dependency unavailable', { requestId: traceId, userId, isAnonymous })
    const response = json({ error: '服务暂时不可用，请稍后再试' }, 503)
    response.headers.set('Retry-After', String(rate.retryAfterSeconds))
    return { response }
  }
  if (!rate.allowed) {
    log.warn('rateLimit', 'Rate limit exceeded', { requestId: traceId, userId, isAnonymous, address })
    const response = json({ error: '请求过于频繁，请稍后再试' }, 429)
    response.headers.set('Retry-After', String(rate.retryAfterSeconds))
    return { response }
  }
  log.info('rateLimit', 'Rate limit check passed', {
    requestId: traceId,
    userId,
    isAnonymous,
    remaining: rate.remaining,
    backend: rate.backend,
  })
  return {}
}

/** Check the account quota without consuming a second request-rate token. */
export async function enforceQuotaLimit(
  auth: AuthCtx,
  options: { quota?: boolean } = {},
  dependencyOverrides: Partial<GuardDependencies> = {},
): Promise<LimitGate> {
  const { supabase, userId } = auth
  if (auth.authUnavailable) {
    const response = json({ error: '认证服务暂时不可用，请稍后再试' }, 503)
    response.headers.set('Retry-After', '5')
    return { response }
  }
  let usingBalance = false
  if (options.quota !== false && userId && supabase) {
    const q = await (dependencyOverrides.quotaCheck ?? DEFAULT_GUARD_DEPENDENCIES.quotaCheck)(
      supabase,
      userId,
    )
    if (q.exceeded) {
      const window = q.which === '5h' ? '5 小时' : '7 天'
      const msg = `${window}用量已达上限，余额也已耗尽，暂时无法发送消息。可在「设置 · 使用额度」充值，或等待窗口重置后继续。`
      return { response: json({ error: msg }, 429) }
    }
    usingBalance = q.usingBalance ?? false
  }

  return { usingBalance }
}

// 默认组合闸门供普通请求使用；大 body 路由应分阶段调用，避免解析前失去限流保护。
export async function enforceLimits(
  auth: AuthCtx,
  request?: Request,
  options: { quota?: boolean } = {},
  dependencyOverrides: Partial<GuardDependencies> = {},
): Promise<LimitGate> {
  const rate = await enforceRequestRateLimit(auth, request, dependencyOverrides)
  if (rate.response) return { response: rate.response }
  return enforceQuotaLimit(auth, options, dependencyOverrides)
}
