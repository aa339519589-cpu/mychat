// 读取网页正文工具：给一个网址，返回该页面适合阅读的纯文本正文。
// 用 Jina Reader（r.jina.ai）把网页转成干净的 Markdown，免费、无需密钥。
import type { ToolDef, ToolOutcome } from './types'

const MAX_CHARS = 8000  // 正文上限，避免一次塞太多灌爆上下文

async function readPage(rawUrl: string): Promise<string> {
  const url = String(rawUrl ?? '').trim()
  if (!/^https?:\/\//i.test(url)) return '无效的网址：必须以 http:// 或 https:// 开头。'
  try {
    const res = await fetch(`https://r.jina.ai/${url}`, {
      headers: { Accept: 'text/plain', 'X-Return-Format': 'markdown' },
      signal: AbortSignal.timeout(20000),
    })
    if (!res.ok) return `打不开这个网页（${res.status}），可能需要登录、不存在或拒绝访问。`
    const body = (await res.text()).trim()
    if (!body) return '这个网页没有可提取的正文内容。'
    return body.length > MAX_CHARS ? `${body.slice(0, MAX_CHARS)}\n\n…（正文过长，已截断）` : body
  } catch {
    return '读取网页超时或出错，请换个网址或稍后再试。'
  }
}

export const fetchUrlTool: ToolDef = {
  name: 'fetch_url',
  description: '打开一个网址并读取网页正文。当用户给出链接，或你在搜索结果里发现值得深入查看的链接时调用，以获取页面全文后再回答。',
  schema: { type: 'object', properties: { url: { type: 'string', description: '要读取的完整网址，必须以 http:// 或 https:// 开头' } }, required: ['url'] },
  enabled: f => f.webSearch,
  execute: async (input): Promise<ToolOutcome> => {
    const text = await readPage(input?.url)
    return { result: text }
  },
}
