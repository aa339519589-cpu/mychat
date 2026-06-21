import { NextRequest } from 'next/server'

export async function POST(req: NextRequest) {
  const { query } = await req.json()
  if (!query?.trim()) return Response.json({ error: '缺少搜索词' }, { status: 400 })

  const apiKey = process.env.TAVILY_API_KEY
  if (!apiKey) return Response.json({ error: 'TAVILY_API_KEY 未配置' }, { status: 500 })

  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query: query.trim(),
      search_depth: 'basic',
      max_results: 5,
      include_answer: true,
    }),
  }).catch(() => null)

  if (!res || !res.ok) {
    return Response.json({ error: '搜索失败，请稍后重试' }, { status: 502 })
  }

  const data = await res.json()

  const results: { title: string; url: string; content: string }[] = (data.results ?? []).map((r: any) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    content: (r.content ?? '').slice(0, 500),
  }))

  const context = [
    data.answer ? `搜索摘要：${data.answer}` : '',
    ...results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.content}`),
  ].filter(Boolean).join('\n\n')

  return Response.json({ context, results })
}
