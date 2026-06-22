import { cookies } from 'next/headers'

// 列出当前 GitHub 账号下所有仓库（按最近更新排序）
export async function GET() {
  const store = await cookies()
  const token = store.get('gh_access_token')?.value
  if (!token) return Response.json({ error: '未连接 GitHub' }, { status: 401 })

  const res = await fetch(
    'https://api.github.com/user/repos?sort=updated&per_page=50&affiliation=owner,collaborator',
    { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'mychat-app', Accept: 'application/vnd.github+json' } },
  ).catch(() => null)

  if (!res?.ok) return Response.json({ error: '获取仓库列表失败' }, { status: res?.status ?? 502 })

  const data = await res.json()
  const repos = (data as any[]).map(r => ({
    name: r.name as string,
    full_name: r.full_name as string,
    private: r.private as boolean,
    description: (r.description ?? '') as string,
  }))
  return Response.json({ repos })
}
