// 速率限制：进程内内存存储。
// 注意：Serverless/多实例部署（Vercel、Render 多容器）下各实例有独立 Map，
// 限流效果减弱。生产环境建议替换为 Supabase 或 Redis 分布式计数器。
const RATE_LIMIT_MAX = 30
const WINDOW_MS = 60 * 1000

interface RateLimitEntry {
  count: number
  resetAt: number
}

type RateLimitStore = Map<string, RateLimitEntry>

const globalStore = globalThis as typeof globalThis & {
  __mychatRateLimitStore?: RateLimitStore
  __mychatRateLimitLastSweep?: number
}

// 在开发热更新和同一 serverless 实例的多次调用之间复用；跨实例仍需由边缘层限流兜底。
const store = globalStore.__mychatRateLimitStore ??= new Map<string, RateLimitEntry>()

export function checkRateLimit(
  key: string,
  options: { max?: number; windowMs?: number } = {},
): { allowed: boolean; remaining: number; retryAfterSeconds: number } {
  const now = Date.now()
  const max = Math.max(1, options.max ?? RATE_LIMIT_MAX)
  const windowMs = Math.max(1000, options.windowMs ?? WINDOW_MS)
  const storageKey = `ratelimit:${key}`
  const entry = store.get(storageKey)

  // 不创建常驻 timer；请求到来时按需清理，避免 serverless 进程被 interval 挂住。
  if (!globalStore.__mychatRateLimitLastSweep || now - globalStore.__mychatRateLimitLastSweep > 5 * 60_000) {
    for (const [storedKey, storedEntry] of store) {
      if (now >= storedEntry.resetAt) store.delete(storedKey)
    }
    globalStore.__mychatRateLimitLastSweep = now
  }

  if (!entry || now >= entry.resetAt) {
    store.set(storageKey, { count: 1, resetAt: now + windowMs })
    return { allowed: true, remaining: max - 1, retryAfterSeconds: 0 }
  }

  if (entry.count >= max) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    }
  }

  entry.count += 1
  return { allowed: true, remaining: max - entry.count, retryAfterSeconds: 0 }
}
