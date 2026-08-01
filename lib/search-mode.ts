export type SearchMode = 'off' | 'web' | 'deep'

export function normalizeSearchMode(input: unknown, deepInput?: unknown): SearchMode {
  if (input === 'deep') return 'deep'
  if (input === 'web') return 'web'
  if (deepInput === true) return 'deep'
  if (input === true) return 'web'
  return 'off'
}

export function searchSourceBudget(mode: SearchMode): { min: number; max: number; target: number } {
  if (mode === 'deep') return { min: 40, max: 80, target: 48 }
  if (mode === 'web') return { min: 1, max: 20, target: 12 }
  return { min: 0, max: 0, target: 0 }
}

function toBeijingDate(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

export function latestBeijingDateFromMessages(messages: Array<{ ts?: string | null }> | undefined): string | null {
  if (!Array.isArray(messages) || messages.length === 0) return null
  let latest = -Infinity
  for (const message of messages) {
    const raw = message?.ts
    if (!raw) continue
    const ms = Date.parse(raw)
    if (Number.isFinite(ms) && ms > latest) latest = ms
  }
  return Number.isFinite(latest) ? toBeijingDate(new Date(latest)) : null
}

export function buildSearchQueries(query: string, mode: SearchMode, latestBeijingDate: string | null): string[] {
  const q = String(query ?? '').trim()
  if (!q) return []
  const datePrefix = latestBeijingDate ? `截至${latestBeijingDate} 北京时间，` : ''
  if (mode !== 'deep') return [`${datePrefix}${q} 最新进展`]
  return [
    `${datePrefix}${q} 最新进展`,
    `${datePrefix}${q} 最新数据`,
    `${datePrefix}${q} 官方消息`,
    `${datePrefix}${q} 新闻报道`,
    `${datePrefix}${q} 分析解读`,
    `${datePrefix}${q} 行业报告`,
  ]
}
