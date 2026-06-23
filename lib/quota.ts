// 额度核算：发送前检查窗口/余额，回复后按加权 token 记账。
// 主聊天 (/api/chat) 与 Code (/api/code/chat) 共用这一份，避免逻辑重复、口径不一。
import { log } from '@/lib/logger'

// 加权额度上限（与 QuotaScreen 展示的 max 一致）
export const QUOTA_LIMIT_5H = 500_000
export const QUOTA_LIMIT_7D = 10_000_000
const MS_5H = 5 * 3600 * 1000
const MS_7D = 7 * 86400 * 1000

// 倍率：鸿篇/深度研究(v4-pro) 3x，正构(思考) 1x，绝句 0.8x
export function tokenMultiplier(model: string, isThinking: boolean) {
  return model.includes('v4-pro') ? 3 : isThinking ? 1 : 0.8
}

// 发送前置检查：当前窗口内加权用量是否已达上限。
// fail-open：任何读取异常（含额度列尚未建表）都放行，绝不因后台问题错杀正常发送。
export async function checkQuotaExceeded(supabase: any, userId: string): Promise<{ exceeded: boolean; which?: '5h' | '7d'; usingBalance?: boolean }> {
  if (!supabase || !userId) return { exceeded: false }
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('tokens_5h, window_5h_start, tokens_7d, window_7d_start, balance')
      .eq('user_id', userId).maybeSingle()
    if (error || !data) {
      log.warn('checkQuota', 'Failed to fetch profile', { userId, error })
      return { exceeded: false }
    }
    const now = Date.now()
    const start5h = new Date((data.window_5h_start as string) || 0).getTime()
    const start7d = new Date((data.window_7d_start as string) || 0).getTime()
    // 窗口已过期 → 视为已清零
    const t5h = now - start5h >= MS_5H ? 0 : ((data.tokens_5h as number) ?? 0)
    const t7d = now - start7d >= MS_7D ? 0 : ((data.tokens_7d as number) ?? 0)
    const windowExceeded = t5h >= QUOTA_LIMIT_5H || t7d >= QUOTA_LIMIT_7D
    if (!windowExceeded) {
      log.info('checkQuota', 'Quota check passed', { userId, tokens_5h: t5h, tokens_7d: t7d })
      return { exceeded: false }
    }
    // 窗口超限：看余额能不能兜底
    const balance = (data.balance as number) ?? 0
    if (balance > 0) {
      log.info('checkQuota', 'Using balance to cover quota', { userId, balance })
      return { exceeded: false, usingBalance: true }
    }
    // 余额也耗尽
    const which: '5h' | '7d' = t5h >= QUOTA_LIMIT_5H ? '5h' : '7d'
    log.warn('checkQuota', 'Quota exceeded and no balance', { userId, which, tokens_5h: t5h, tokens_7d: t7d })
    return { exceeded: true, which }
  } catch (e) {
    log.error('checkQuota', 'Exception checking quota', e)
    return { exceeded: false }
  }
}

// 写额度：乐观锁 quota_version 防并发抢占，冲突重试。
// usingBalance=true 时：时间窗口继续累计（记录真实用量），同时从余额扣除
export async function addQuotaUsage(supabase: any, userId: string, rawTokens: number, model: string, isThinking: boolean, usingBalance = false) {
  if (!supabase || !userId || rawTokens <= 0) return
  const weighted = Math.round(rawTokens * tokenMultiplier(model, isThinking))
  log.info('quota', 'Adding quota usage', { userId, rawTokens, weighted, model, isThinking, usingBalance })
  for (let retry = 0; retry < 3; retry++) {
    try {
      const { data, error: selErr } = await supabase
        .from('profiles')
        .select('tokens_5h, window_5h_start, tokens_7d, window_7d_start, quota_version, balance')
        .eq('user_id', userId).maybeSingle()
      if (selErr) {
        log.error('quota', 'Failed to fetch profile (quota table may not exist, see supabase/quota.sql)', selErr)
        return
      }
      // 档案行缺失：先建一行（窗口此刻起算），下一轮重试再累加
      if (!data) {
        const nowIso = new Date().toISOString()
        const { error: insErr } = await supabase.from('profiles').upsert(
          { user_id: userId, tokens_5h: 0, window_5h_start: nowIso, tokens_7d: 0, window_7d_start: nowIso, quota_version: 0 },
          { onConflict: 'user_id' },
        )
        if (insErr) {
          log.error('quota', 'Failed to create profile row', insErr)
          return
        }
        continue
      }
      const now = Date.now()
      const nowIso = new Date(now).toISOString()
      const start5h = new Date((data.window_5h_start as string) || 0).getTime()
      const start7d = new Date((data.window_7d_start as string) || 0).getTime()
      const oldVersion = (data.quota_version as number) ?? 0
      const newTokens5h = (now - start5h >= MS_5H ? 0 : ((data.tokens_5h as number) ?? 0)) + weighted
      const newTokens7d = (now - start7d >= MS_7D ? 0 : ((data.tokens_7d as number) ?? 0)) + weighted
      const newWindow5h = now - start5h >= MS_5H ? nowIso : ((data.window_5h_start as string) ?? nowIso)
      const newWindow7d = now - start7d >= MS_7D ? nowIso : ((data.window_7d_start as string) ?? nowIso)
      const updatePayload: Record<string, unknown> = {
        tokens_5h: newTokens5h,
        window_5h_start: newWindow5h,
        tokens_7d: newTokens7d,
        window_7d_start: newWindow7d,
        quota_version: oldVersion + 1,
      }
      if (usingBalance) {
        const currentBalance = (data.balance as number) ?? 0
        updatePayload.balance = Math.max(0, currentBalance - weighted)
      }
      const { data: updated, error: updErr } = await supabase
        .from('profiles')
        .update(updatePayload)
        .eq('user_id', userId)
        .eq('quota_version', oldVersion)
        .select('quota_version')
      if (updErr) {
        log.error('quota', 'Failed to update quota (quota table may not exist, see supabase/quota.sql)', updErr)
        return
      }
      if (updated && updated.length > 0) {
        log.info('quota', 'Quota usage recorded', { userId, tokens_5h: newTokens5h, tokens_7d: newTokens7d })
        return
      }
      // 0 行 = 版本号被并发请求抢占，重试
    } catch (e) {
      log.error('quota', 'Exception in addQuotaUsage', e)
      return
    }
  }
  log.warn('quota', 'Optimistic lock conflict, quota usage not recorded', { userId })
}
