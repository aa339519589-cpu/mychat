// Route 守卫层：把两个流式 route 复制粘贴的「鉴权 + 限流 + 额度」前导逻辑收敛到一处。
// route 只需：const auth = await resolveAuth(); const gate = await enforceLimits(auth); if (gate.response) return gate.response
import { createClient } from '@/lib/supabase/server'
import { checkRateLimit } from '@/lib/rate-limit'
import { checkQuotaExceeded } from '@/lib/quota'
import { log } from '@/lib/logger'

export type SupabaseServer = Awaited<ReturnType<typeof createClient>>
export type AuthCtx = { supabase: SupabaseServer | null; userId: string | null }

function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } })
}

// 解析当前登录用户；任何异常都降级为「未登录」，绝不抛出（游客可继续用受限功能）。
export async function resolveAuth(): Promise<AuthCtx> {
  try {
    const supabase = await createClient()
    const { data } = await supabase.auth.getUser()
    return { supabase, userId: data.user?.id ?? null }
  } catch {
    return { supabase: null, userId: null }
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

// 限流 + 额度闸门：通过返回 { usingBalance }，未通过返回 { response }（429，调用方直接 return）。
export async function enforceLimits(auth: AuthCtx): Promise<LimitGate> {
  const { supabase, userId } = auth

  if (userId) {
    const { allowed, remaining } = checkRateLimit(userId)
    if (!allowed) {
      log.warn('rateLimit', 'Rate limit exceeded', { userId })
      return { response: json({ error: '请求过于频繁，请稍后再试' }, 429) }
    }
    log.info('rateLimit', 'Rate limit check passed', { userId, remaining })
  }

  let usingBalance = false
  if (userId && supabase) {
    const q = await checkQuotaExceeded(supabase, userId)
    if (q.exceeded) {
      const window = q.which === '5h' ? '5 小时' : '7 天'
      const msg = `${window}用量已达上限，余额也已耗尽，暂时无法发送消息。可在「设置 · 使用额度」充值，或等待窗口重置后继续。`
      return { response: json({ error: msg }, 429) }
    }
    usingBalance = q.usingBalance ?? false
  }

  return { usingBalance }
}
