import { cookies } from 'next/headers'

// 前端用来判断当前用户是否已连接 GitHub
export async function GET() {
  const store = await cookies()
  const token = store.get('gh_access_token')?.value
  const login = store.get('gh_login')?.value
  return Response.json({ connected: !!token, login: login ? decodeURIComponent(login) : null })
}
