import { listRepos } from '@/lib/github'
import { getGitHubSession } from '@/lib/github-session'

// 列出当前 GitHub 账号下所有仓库（按最近更新排序）
export async function GET() {
  const session = await getGitHubSession()
  if (!session) return Response.json({ error: '未连接 GitHub 或账号会话已变化' }, { status: 401 })
  const repos = await listRepos(session.token)
  return Response.json({ repos })
}
