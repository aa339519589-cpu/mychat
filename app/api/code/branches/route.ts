import { NextRequest } from 'next/server'
import { getGitHubSession } from '@/lib/github-session'
import { requestId } from '@/lib/api/request'
import { isValidGitHubRepository } from '@/lib/agent/git-publish/shared'
import { repoMeta } from '@/lib/github'

function branchRows(data: unknown): Array<{ name: string; protected: boolean }> {
  if (!Array.isArray(data)) throw new Error('invalid branches')
  return data.flatMap(row => row && typeof row === 'object' && 'name' in row && typeof row.name === 'string'
    ? [{ name: row.name, protected: 'protected' in row && row.protected === true }] : [])
}

export async function GET(request: NextRequest) {
  const repo = request.nextUrl.searchParams.get('repo') ?? ''
  if (!isValidGitHubRepository(repo)) return Response.json({ error: '仓库参数无效' }, { status: 400 })
  const session = await getGitHubSession({ purpose: 'code.branches', requestId: requestId(request), request })
  if (!session) return Response.json({ error: '请先连接 GitHub' }, { status: 401 })
  const metadata = await repoMeta(session.token, repo)
  if (!metadata) return Response.json({ error: '仓库不存在或当前授权不可访问' }, { status: 404 })
  const branches: Array<{ name: string; protected: boolean }> = []
  let truncated = false
  try {
    for (let page = 1; page <= 3; page++) {
      const response = await fetch(`https://api.github.com/repos/${repo}/branches?per_page=100&page=${page}`, {
        headers: { Authorization: `Bearer ${session.token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'mychat-app' },
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]), redirect: 'error',
      })
      if (!response.ok) return Response.json({ error: 'GitHub 分支读取失败', upstreamStatus: response.status }, { status: 502 })
      const data: unknown = await response.json()
      if (!Array.isArray(data)) throw new Error('invalid branches')
      branches.push(...branchRows(data))
      if (data.length < 100) break
      if (page === 3) truncated = true
    }
    return Response.json({ repo, defaultBranch: metadata.defaultBranch, branches, truncated },
      { headers: { 'Cache-Control': 'no-store' } })
  } catch { return Response.json({ error: 'GitHub 分支服务暂时不可用' }, { status: 502 }) }
}
