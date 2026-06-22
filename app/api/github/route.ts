import { NextRequest } from 'next/server'
import { cookies } from 'next/headers'

// 读取指定仓库的基本信息和 README，作为 AI 对话上下文注入
export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get('repo')
  if (!url) return Response.json({ error: '缺少 repo 参数' }, { status: 400 })

  // 优先用 OAuth token（可访问私有仓库），无 token 则走未认证请求
  const store = await cookies()
  const token = store.get('gh_access_token')?.value

  let owner = '', repo = ''
  const urlMatch = url.match(/github\.com\/([^/]+)\/([^/\s]+)/)
  if (urlMatch) {
    owner = urlMatch[1]
    repo = urlMatch[2].replace(/\.git$/, '')
  } else {
    const parts = url.trim().split('/')
    if (parts.length >= 2) { owner = parts[0]; repo = parts[1] }
  }
  if (!owner || !repo) return Response.json({ error: '格式不正确，请输入 owner/repo 或 GitHub 链接' }, { status: 400 })

  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'mychat-app' }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers }).catch(() => null)
  if (!repoRes || !repoRes.ok) {
    const status = repoRes?.status ?? 0
    if (status === 404) return Response.json({ error: `找不到仓库 ${owner}/${repo}` }, { status: 404 })
    if (status === 403 || status === 429) return Response.json({ error: 'GitHub API 请求次数超限，请稍后再试' }, { status: 429 })
    return Response.json({ error: '无法访问 GitHub，请检查仓库名' }, { status: 502 })
  }
  const repoData = await repoRes.json()

  let readmeText = ''
  const readmeRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/readme`, { headers }).catch(() => null)
  if (readmeRes?.ok) {
    const readmeData = await readmeRes.json()
    const base64 = (readmeData.content as string).replace(/\n/g, '')
    readmeText = Buffer.from(base64, 'base64').toString('utf-8')
  }

  const context = `仓库：${repoData.full_name}\n描述：${repoData.description || '无'}\n语言：${repoData.language || '未知'}\nStars：${repoData.stargazers_count}\nREADME：\n${readmeText.slice(0, 4000)}`
  return Response.json({ repo: repoData.full_name, description: repoData.description, context })
}
