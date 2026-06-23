import { cookies } from 'next/headers'
import { commitAndOpenPR, type CommitFile } from '@/lib/github'

// 用户在 Code 里点「确认提交」后调用：建新分支 → 提交 → 开 PR。
// 安全闸：≤5 文件、总量 ≤300KB、实时校验写权限（在 commitAndOpenPR 内）、永不写默认分支。
export async function POST(req: Request) {
  const store = await cookies()
  const token = store.get('gh_access_token')?.value
  if (!token) return Response.json({ error: '未连接 GitHub' }, { status: 401 })

  const body = await req.json().catch(() => null)
  if (!body) return Response.json({ error: '请求体格式错误' }, { status: 400 })

  const { repo, files, message } = body as { repo: string; files: CommitFile[]; message: string }
  if (!repo || !Array.isArray(files) || files.length === 0) return Response.json({ error: '参数错误' }, { status: 400 })
  if (files.length > 5) return Response.json({ error: '单次最多提交 5 个文件' }, { status: 400 })
  const totalSize = files.reduce((s, f) => s + (f.content?.length ?? 0), 0)
  if (totalSize > 300_000) return Response.json({ error: '内容总量超过 300KB 限制' }, { status: 400 })

  const result = await commitAndOpenPR(token, repo, files, message ?? 'Claude 代码修改', Date.now())
  if ('error' in result) return Response.json({ error: result.error }, { status: 502 })
  return Response.json(result)
}
