export type SearchMode = 'off' | 'web'
export type SearchTimeRange = 'day' | 'week' | 'month' | null

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

export function latestBeijingDateFromMessages(
  messages: Array<{ ts?: string | null }> | undefined,
  now: Date = new Date(),
): string | null {
  let latest = Number.isFinite(now.getTime()) ? now.getTime() : -Infinity
  if (Array.isArray(messages)) {
    for (const message of messages) {
      const raw = message?.ts
      if (!raw) continue
      const ms = Date.parse(raw)
      if (Number.isFinite(ms) && ms > latest) latest = ms
    }
  }
  return Number.isFinite(latest) ? toBeijingDate(new Date(latest)) : null
}

const DAY_FRESHNESS = /今天|今日|刚刚|实时|此刻|截至现在|today|right now|breaking/i
const WEEK_FRESHNESS = /本周|这周|近7天|最近一周|过去一周|this week|past week|last 7 days/i
const MONTH_FRESHNESS = /本月|这个月|近30天|最近一个月|过去一个月|最新|近期|最近|目前|现在|当前|发布|上线|更新|进展|新闻|价格|股价|汇率|比分|赛程|选举|总统|首相|CEO|this month|past month|last 30 days|latest|recent|current|news|update|release|price|score|schedule/i

export function inferSearchTimeRange(query: string): SearchTimeRange {
  const q = String(query ?? '').trim()
  if (!q) return null
  if (DAY_FRESHNESS.test(q)) return 'day'
  if (WEEK_FRESHNESS.test(q)) return 'week'
  if (MONTH_FRESHNESS.test(q)) return 'month'
  return null
}

export function buildSearchQueries(query: string, latestBeijingDate: string | null): string[] {
  const q = String(query ?? '').trim()
  if (!q) return []
  const datePrefix = latestBeijingDate ? `截至${latestBeijingDate} 北京时间，` : ''
  const dateSuffix = latestBeijingDate ? ` ${latestBeijingDate}` : ''
  return [
    `${datePrefix}${q} 最新进展`,
    `${q} 官方公告 最新发布${dateSuffix}`,
  ].filter((item, index, all) => all.indexOf(item) === index)
}
