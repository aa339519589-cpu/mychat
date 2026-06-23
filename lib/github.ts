// GitHub API 共享库：列仓库、列文件树、读文件、校验写权限、建分支+提交+开 PR。
// access token 只在服务端使用（从 gh_access_token Cookie 取），绝不下发前端。
// Code 的 agentic loop 与 /api/github/commit 都复用这一份，杜绝重复实现。

const GH = 'https://api.github.com'

function ghHeaders(token: string, json = false): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'User-Agent': 'mychat-app',
    Accept: 'application/vnd.github+json',
  }
  if (json) h['Content-Type'] = 'application/json'
  return h
}

export type RepoItem = { name: string; full_name: string; private: boolean; description: string }

// 当前账号下的仓库（按最近更新排序，只取有 push 权限或自己拥有的）
export async function listRepos(token: string): Promise<RepoItem[]> {
  const res = await fetch(`${GH}/user/repos?sort=updated&per_page=50&affiliation=owner,collaborator`, { headers: ghHeaders(token) }).catch(() => null)
  if (!res?.ok) return []
  const data = await res.json()
  return (data as any[]).map(r => ({
    name: r.name as string,
    full_name: r.full_name as string,
    private: r.private as boolean,
    description: (r.description ?? '') as string,
  }))
}

export type RepoMeta = { defaultBranch: string; canPush: boolean }

// 仓库元信息：默认分支 + 当前用户是否有写权限
export async function repoMeta(token: string, repo: string): Promise<RepoMeta | null> {
  const res = await fetch(`${GH}/repos/${repo}`, { headers: ghHeaders(token) }).catch(() => null)
  if (!res?.ok) return null
  const data = await res.json()
  return {
    defaultBranch: data.default_branch as string,
    canPush: !!(data.permissions as any)?.push,
  }
}

// 完整文件路径列表（默认分支，递归）。只返回文件（blob），上限 N 条。
export async function listTree(token: string, repo: string, branch: string, limit = 400): Promise<{ paths: string[]; truncated: boolean }> {
  const res = await fetch(`${GH}/repos/${repo}/git/trees/${branch}?recursive=1`, { headers: ghHeaders(token) }).catch(() => null)
  if (!res?.ok) return { paths: [], truncated: false }
  const data = await res.json()
  const blobs = (data.tree as any[]).filter(item => item.type === 'blob').map(item => item.path as string)
  return { paths: blobs.slice(0, limit), truncated: blobs.length > limit || !!data.truncated }
}

export type FileContent = { content: string; sha: string }

// 读单个文件内容（解码 base64）+ sha（提交时防并发覆盖必须用到）
export async function readFile(token: string, repo: string, path: string, maxBytes = 120_000): Promise<FileContent | { error: string }> {
  const res = await fetch(`${GH}/repos/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`, { headers: ghHeaders(token) }).catch(() => null)
  if (!res?.ok) return { error: res?.status === 404 ? '文件不存在' : '文件读取失败' }
  const data = await res.json()
  if (Array.isArray(data)) return { error: '这是一个目录，不是文件' }
  if ((data.size as number) > maxBytes) return { error: `文件过大（${Math.round((data.size as number) / 1024)}KB，超过 ${Math.round(maxBytes / 1024)}KB 上限）` }
  const content = Buffer.from(String(data.content ?? '').replace(/\n/g, ''), 'base64').toString('utf-8')
  return { content, sha: data.sha as string }
}

export type CommitFile = { path: string; content: string; sha: string }
export type CommitResult = { prUrl: string; prNumber: number; branch: string } | { error: string }

// 建新分支 → 逐文件提交 → 开 PR。严禁直接写默认分支。
export async function commitAndOpenPR(token: string, repo: string, files: CommitFile[], message: string, timestamp: number): Promise<CommitResult> {
  const meta = await repoMeta(token, repo)
  if (!meta) return { error: '仓库访问失败' }
  if (!meta.canPush) return { error: '你对该仓库没有写入权限' }
  const defaultBranch = meta.defaultBranch

  // 默认分支最新 commit SHA
  const branchRes = await fetch(`${GH}/repos/${repo}/branches/${defaultBranch}`, { headers: ghHeaders(token) }).catch(() => null)
  if (!branchRes?.ok) return { error: '获取分支信息失败' }
  const baseSha = ((await branchRes.json()).commit as any).sha as string

  // 新分支
  const branch = `claude/edit-${timestamp}`
  const refRes = await fetch(`${GH}/repos/${repo}/git/refs`, {
    method: 'POST', headers: ghHeaders(token, true),
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
  }).catch(() => null)
  if (!refRes?.ok) {
    const err = await refRes?.json().catch(() => null)
    return { error: `创建分支失败：${(err as any)?.message ?? '未知错误'}` }
  }

  // 逐文件提交到新分支（带旧 sha 防覆盖）
  for (const f of files) {
    const putRes = await fetch(`${GH}/repos/${repo}/contents/${encodeURIComponent(f.path).replace(/%2F/g, '/')}`, {
      method: 'PUT', headers: ghHeaders(token, true),
      body: JSON.stringify({
        message: `${message || 'Claude 代码修改'}: ${f.path}`,
        content: Buffer.from(f.content, 'utf-8').toString('base64'),
        sha: f.sha,
        branch,
      }),
    }).catch(() => null)
    if (!putRes?.ok) {
      const err = await putRes?.json().catch(() => null)
      return { error: `提交文件失败 (${f.path})：${(err as any)?.message ?? '未知错误'}` }
    }
  }

  // 开 PR
  const title = (message || 'Claude 代码修改').split('\n')[0].slice(0, 72)
  const body = `由 Claude（Code 板块）自动生成。\n\n**改动文件：**\n${files.map(f => `- \`${f.path}\``).join('\n')}\n\n---\n${message || ''}`
  const prRes = await fetch(`${GH}/repos/${repo}/pulls`, {
    method: 'POST', headers: ghHeaders(token, true),
    body: JSON.stringify({ title, body, head: branch, base: defaultBranch }),
  }).catch(() => null)
  if (!prRes?.ok) {
    const err = await prRes?.json().catch(() => null)
    return { error: `创建 PR 失败：${(err as any)?.message ?? '未知错误'}` }
  }
  const pr = await prRes.json()
  return { prUrl: pr.html_url as string, prNumber: pr.number as number, branch }
}
