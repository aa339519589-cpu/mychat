// 联网搜索工具：调用 Tavily 查最新信息
import type { ToolDef, ToolOutcome } from './types'

// 调用 Tavily 联网搜索，返回给模型的文字 + 给前端展示的来源列表
async function tavilySearch(query: string): Promise<{ text: string; results: { title: string; url: string }[] }> {
  const apiKey = process.env.TAVILY_API_KEY
  const q = String(query ?? '').trim()
  if (!apiKey || !q) return { text: '联网搜索当前不可用。', results: [] }
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, query: q, search_depth: 'basic', max_results: 5, include_answer: true }),
    })
    if (!res.ok) return { text: '搜索失败，请稍后再试。', results: [] }
    const data = await res.json()
    const results = (data.results ?? []).map((r: any) => ({ title: r.title ?? '', url: r.url ?? '' }))
    const text = [
      data.answer ? `摘要：${data.answer}` : '',
      ...(data.results ?? []).map((r: any, i: number) => `[${i + 1}] ${r.title}\n${r.url}\n${(r.content ?? '').slice(0, 500)}`),
    ].filter(Boolean).join('\n\n')
    return { text: text || '没有找到相关结果。', results }
  } catch {
    return { text: '搜索出错。', results: [] }
  }
}

export const webSearchTool: ToolDef = {
  name: 'web_search',
  description: '联网搜索互联网上的最新信息。当问题涉及实时信息、最新事件、近期数据，或你不确定、可能已过时的事实时调用。',
  schema: { type: 'object', properties: { query: { type: 'string', description: '搜索关键词' } }, required: ['query'] },
  enabled: f => f.webSearch,
  execute: async (input): Promise<ToolOutcome> => {
    const { text, results } = await tavilySearch(input?.query)
    return { result: text, event: { search: { query: String(input?.query ?? ''), results } } }
  },
}
