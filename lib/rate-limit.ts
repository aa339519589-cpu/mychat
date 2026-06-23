const LIMIT = 30 // requests per minute
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
    return { allowed: true, remaining: LIMIT - 1 }
  }

  if (entry.count >= LIMIT) {
    return { allowed: false, remaining: 0 }
  }

  entry.count += 1
  return { allowed: true, remaining: LIMIT - entry.count }
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
