export type RetrievalHit = {
  id: string
  conversation_id: string
  conversation_title: string | null
  project_id: string | null
  message_start_id: string | null
  message_end_id: string | null
  content: string
  similarity: number
  created_at: string | null
}


export function queryTerms(query: string): string[] {
  const base = query.toLowerCase()
    .replace(/[()&|!:*'"<>【】\[\]{}]/g, ' ')
    .split(/[\s,，。.!?！？、/\\|：:]+/)
    .map(w => w.trim())
    .filter(w => w.length >= 2)

  const extra: string[] = []
  if (query.includes('中午') || query.includes('午饭') || query.includes('午餐')) extra.push('中午', '午饭', '午餐', '吃')
  if (query.includes('吃')) extra.push('吃', '饭', '吃了')
  if (query.includes('今晚') || query.includes('今天晚上')) extra.push('今晚', '今天晚上', '晚上')
  if (query.includes('干什么') || query.includes('做什么')) extra.push('干什么', '做什么', '安排')

  return Array.from(new Set([...base, ...extra])).slice(0, 28)
}

export function keywordScore(query: string, content: string): number {
  const words = queryTerms(query)
  if (!words.length) return 0
  const lower = content.toLowerCase()
  return words.reduce((acc, w) => acc + (lower.includes(w.toLowerCase()) ? 0.05 : 0), 0)
}

export function textSearchQuery(query: string): string {
  return queryTerms(query).slice(0, 12).join(' | ')
}

export function dedupeHits(hits: RetrievalHit[]): RetrievalHit[] {
  const seen = new Set<string>()
  const out: RetrievalHit[] = []
  for (const hit of hits) {
    const key = `${hit.conversation_id}:${hit.message_start_id}:${hit.message_end_id}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(hit)
  }
  return out
}


