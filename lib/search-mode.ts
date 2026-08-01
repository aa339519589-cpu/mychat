export type SearchMode = 'off' | 'web'

export function normalizeSearchMode(input: unknown): SearchMode {
  if (input === 'web' || input === true) return 'web'
  return 'off'
}

export function searchSourceBudget(mode: SearchMode): { min: number; max: number; target: number } {
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

export function buildSearchQueries(query: string, latestBeijingDate: string | null): string[] {
  const q = String(query ?? '').trim()
  if (!q) return []
  const datePrefix = latestBeijingDate ? `截至${latestBeijingDate} 北京时间，` : ''
  return [`${datePrefix}${q} 最新进展`]
}
