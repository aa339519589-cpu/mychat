// 额度核算：发送前检查窗口/余额，回复后按加权 token 记账。
// 主聊天 (/api/chat) 与 Code (/api/code/chat) 共用这一份，避免逻辑重复、口径不一。
import { log } from '@/lib/logger'
import type { SupabaseClient } from '@supabase/supabase-js'

// 加权额度上限（与 QuotaScreen 展示的 max 一致）
const QUOTA_LIMIT_5H = 500_000
const QUOTA_LIMIT_7D = 10_000_000

// 倍率：深度档（DeepSeek Pro / 反代 Grok 等）3x，正构(思考) 1x，绝句 0.8x
export function tokenMultiplier(model: string, isThinking: boolean) {
  if (model.includes('v4-pro') || /grok/i.test(model)) return 3
  return isThinking ? 1 : 0.8
}

export function weightedTokenUsage(rawTokens: number, model: string, isThinking: boolean): number {
  if (!Number.isFinite(rawTokens) || rawTokens <= 0) return 0
  return Math.max(0, Math.round(rawTokens * tokenMultiplier(model, isThinking)))
}

// 发送前置检查：当前窗口内加权用量是否已达上限。
// fail-open：任何读取异常（含额度列尚未建表）都放行，绝不因后台问题错杀正常发送。
export type QuotaDecision = {
  exceeded: boolean
  which?: '5h' | '7d'
  usingBalance?: boolean
  unavailable?: boolean
}

function finiteNonnegative(value: unknown): number | null {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(number) && number >= 0 ? number : null
}

export async function checkQuotaExceeded(
  supabase: SupabaseClient | null,
  userId: string,
): Promise<QuotaDecision> {
  if (!supabase || !userId) return { exceeded: false }
  try {
    const { data, error } = await supabase.rpc('get_ledger_quota_status', {
      input_principal_id: userId,
    })
    if (error || !data || typeof data !== 'object' || Array.isArray(data)) {
      log.error('checkQuota', 'Ledger quota authority unavailable', {
        userId,
        code: error?.code ?? 'invalid_response',
      })
      return { exceeded: false, unavailable: true }
    }
    const row = data as Record<string, unknown>
    const t5h = finiteNonnegative(row.tokens5h)
    const t7d = finiteNonnegative(row.tokens7d)
    const balance = finiteNonnegative(row.balance)
    const limit5h = finiteNonnegative(row.limit5h) ?? QUOTA_LIMIT_5H
    const limit7d = finiteNonnegative(row.limit7d) ?? QUOTA_LIMIT_7D
    if (t5h === null || t7d === null || balance === null) {
      return { exceeded: false, unavailable: true }
    }
    const windowExceeded = t5h >= limit5h || t7d >= limit7d
    if (!windowExceeded) {
      log.info('checkQuota', 'Quota check passed', { userId, tokens_5h: t5h, tokens_7d: t7d })
      return { exceeded: false }
    }
    // 窗口超限：看余额能不能兜底
    if (balance > 0) {
      log.info('checkQuota', 'Using balance to cover quota', { userId, balance })
      return { exceeded: false, usingBalance: true }
    }
    // 余额也耗尽
    const which: '5h' | '7d' = t5h >= limit5h ? '5h' : '7d'
    log.warn('checkQuota', 'Quota exceeded and no balance', { userId, which, tokens_5h: t5h, tokens_7d: t7d })
    return { exceeded: true, which }
  } catch (e) {
    log.error('checkQuota', 'Exception checking quota', e)
    return { exceeded: false, unavailable: true }
  }
}

// 写额度只允许数据库原子 RPC；read-modify-write 回退会在并发下丢失或重复记账。
export async function addQuotaUsage(supabase: SupabaseClient | null, userId: string, rawTokens: number, model: string, isThinking: boolean, usingBalance = false) {
  if (!supabase || !userId || rawTokens <= 0) return
  const weighted = weightedTokenUsage(rawTokens, model, isThinking)
  log.info('quota', 'Adding quota usage', { userId, rawTokens, weighted, model, isThinking, usingBalance })
  try {
    const { error } = await supabase.rpc('record_quota_usage', {
      weighted_tokens: weighted,
      use_balance: usingBalance,
    })
    if (error) log.error('quota', 'Atomic quota usage failed', { userId, weighted, code: error.code })
    else log.info('quota', 'Quota usage recorded atomically', { userId, weighted })
  } catch (error) {
    log.error('quota', 'Atomic quota usage unavailable', { userId, weighted, error })
  }
}
