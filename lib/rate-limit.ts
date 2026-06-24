// 速率限制：进程内内存存储。
// 注意：Serverless/多实例部署（Vercel、Render 多容器）下各实例有独立 Map，
// 限流效果减弱。生产环境建议替换为 Supabase 或 Redis 分布式计数器。
const RATE_LIMIT_MAX = 30  // 每分钟最大请求数
const WINDOW_MS = 60 * 1000

interface RateLimitEntry {
  count: number
  resetAt: number
}

const store = new Map<string, RateLimitEntry>()

export function checkRateLimit(userId: string): { allowed: boolean; remaining: number } {
  const now = Date.now()
  const key = `ratelimit:${userId}`
  const entry = store.get(key)

  if (!entry || now >= entry.resetAt) {
    // New window
    store.set(key, { count: 1, resetAt: now + WINDOW_MS })
    return { allowed: true, remaining: RATE_LIMIT_MAX - 1 }
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return { allowed: false, remaining: 0 }
  }

  entry.count += 1
  return { allowed: true, remaining: RATE_LIMIT_MAX - entry.count }
}

// Cleanup old entries every 5 minutes
setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of store.entries()) {
    if (now >= entry.resetAt) {
      store.delete(key)
    }
  }
}, 5 * 60 * 1000)
