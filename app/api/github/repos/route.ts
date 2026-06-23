import { cookies } from 'next/headers'
import { listRepos } from '@/lib/github'

// 列出当前 GitHub 账号下所有仓库（按最近更新排序）
export async function GET() {
  const store = await cookies()
  const token = store.get('gh_access_token')?.value
  if (!token) return Response.json({ error: '未连接 GitHub' }, { status: 401 })
  const repos = await listRepos(token)
  return Response.json({ repos })
}
