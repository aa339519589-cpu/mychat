import { getGitHubSession } from '@/lib/github-session'

// 前端用来判断当前用户是否已连接 GitHub
export async function GET() {
  const session = await getGitHubSession()
  return Response.json({ connected: !!session, login: session?.login || null })
}
