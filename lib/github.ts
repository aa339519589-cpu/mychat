// GitHub API 共享库：列仓库、列文件树、读文件、校验写权限、建分支+提交+开 PR。
// access token 只在服务端使用（从 gh_access_token Cookie 取），绝不下发前端。
// Code 的 agentic loop（/api/code/chat）与执行端点（/api/code/apply）都复用这一份，杜绝重复实现。

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

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// 仓库名清洗成 GitHub 合法格式：小写、非法字符转连字符、去首尾连字符
function sanitizeRepoName(raw: string): string {
  const n = raw.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90)
  return n || 'project'
}

// 新建仓库（auto_init 让它带一个初始提交，后续可直接提交文件）。
// 名字清洗；重名自动加后缀重试；权限不足给出"重连 GitHub"的明确指引。
export async function createRepo(token: string, name: string, description: string, isPrivate: boolean): Promise<{ fullName: string; defaultBranch: string; htmlUrl: string } | { error: string }> {
  const base = sanitizeRepoName(name)
  for (let attempt = 0; attempt < 5; attempt++) {
    const tryName = attempt === 0 ? base : `${base}-${attempt + 1}`
    let res: Response | null = null
    try {
      res = await fetch(`${GH}/user/repos`, {
        method: 'POST', headers: ghHeaders(token, true),
        body: JSON.stringify({ name: tryName, description: description || '', private: isPrivate, auto_init: true }),
      })
    } catch (e) {
      return { error: `网络错误：${e instanceof Error ? e.message : '无法连接到 GitHub'}` }
    }
    if (res.ok) {
      const d = await res.json()
      return { fullName: d.full_name as string, defaultBranch: d.default_branch as string, htmlUrl: d.html_url as string }
    }
    let err: any = null
    try {
      err = await res.json()
    } catch {
      err = { message: `HTTP ${res.status} ${res.statusText || ''}`.trim() }
    }
    const raw = JSON.stringify(err ?? {})
    // 重名 → 换个后缀再试
    if (res.status === 422 && /already exists/i.test(raw)) continue
    // 权限/scope 不足
    if (res.status === 403 || res.status === 404) {
      return { error: '当前 GitHub 授权没有创建仓库的权限。请点右上角 @用户名 → 断开 GitHub，再重新连接（会重新授权完整权限）。' }
    }
    // 其他错误
    const msg = (err as any)?.message || (err as any)?.errors?.[0]?.message || `HTTP ${res.status}`
    return { error: `创建仓库失败：${msg}` }
  }
  return { error: '同名仓库已存在多个，请换一个项目名再试。' }
}

// 取某分支 HEAD 的 commit sha；可重试（新建仓库 auto_init 后引用可能稍有延迟）
async function getHeadSha(token: string, repo: string, branch: string, retries = 0): Promise<string | null> {
  for (let i = 0; i <= retries; i++) {
    const res = await fetch(`${GH}/repos/${repo}/git/ref/heads/${branch}`, { headers: ghHeaders(token) }).catch(() => null)
    if (res?.ok) { const sha = ((await res.json()).object as any)?.sha; if (sha) return sha }
    if (i < retries) await sleep(600)
  }
  return null
}

// 一个文件写操作：content=null 表示删除该文件
export type FileWrite = { path: string; content: string | null }

// 用 Git Data API 把多个文件改动打成【一个原子提交】直接推到分支。
// 创建/更新/删除统一处理，无需逐文件 sha；新仓库、新文件都适用。直接写默认分支（用户已选直接推送）。
export async function commitFiles(token: string, repo: string, branch: string, files: FileWrite[], message: string): Promise<{ commitSha: string } | { error: string }> {
  const baseSha = await getHeadSha(token, repo, branch, 3)  // 新仓库刚建好，引用可能稍有延迟，重试几次
  if (!baseSha) return { error: '获取分支 HEAD 失败' }

  // 基树
  const commitRes = await fetch(`${GH}/repos/${repo}/git/commits/${baseSha}`, { headers: ghHeaders(token) }).catch(() => null)
  if (!commitRes?.ok) return { error: '获取基树失败' }
  const baseTreeSha = ((await commitRes.json()).tree as any).sha as string

  // 为写入的文件创建 blob；删除项 sha 置 null
  const treeItems: any[] = []
  for (const f of files) {
    if (f.content === null) {
      treeItems.push({ path: f.path, mode: '100644', type: 'blob', sha: null })
      continue
    }
    const blobRes = await fetch(`${GH}/repos/${repo}/git/blobs`, {
      method: 'POST', headers: ghHeaders(token, true),
      body: JSON.stringify({ content: Buffer.from(f.content, 'utf-8').toString('base64'), encoding: 'base64' }),
    }).catch(() => null)
    if (!blobRes?.ok) return { error: `创建 blob 失败 (${f.path})` }
    treeItems.push({ path: f.path, mode: '100644', type: 'blob', sha: (await blobRes.json()).sha })
  }

  // 新树
  const treeRes = await fetch(`${GH}/repos/${repo}/git/trees`, {
    method: 'POST', headers: ghHeaders(token, true),
    body: JSON.stringify({ base_tree: baseTreeSha, tree: treeItems }),
  }).catch(() => null)
  if (!treeRes?.ok) return { error: '创建树失败' }
  const newTreeSha = (await treeRes.json()).sha as string

  // 新提交
  const newCommitRes = await fetch(`${GH}/repos/${repo}/git/commits`, {
    method: 'POST', headers: ghHeaders(token, true),
    body: JSON.stringify({ message: message || 'Claude 代码改动', tree: newTreeSha, parents: [baseSha] }),
  }).catch(() => null)
  if (!newCommitRes?.ok) return { error: '创建提交失败' }
  const newCommitSha = (await newCommitRes.json()).sha as string

  // 推进分支引用
  const refRes = await fetch(`${GH}/repos/${repo}/git/refs/heads/${branch}`, {
    method: 'PATCH', headers: ghHeaders(token, true),
    body: JSON.stringify({ sha: newCommitSha, force: false }),
  }).catch(() => null)
  if (!refRes?.ok) {
    const err = await refRes?.json().catch(() => null)
    return { error: `推送失败：${(err as any)?.message ?? '未知错误'}` }
  }
  return { commitSha: newCommitSha }
}

export type PagesResult =
  | { status: 'ready'; url: string }
  | { status: 'pending'; url: string }
  | { status: 'failed'; url: string; error: string }

// 开启 Pages 后等待 GitHub 构建完成，并验证最终网址确实可访问。
export async function enablePages(
  token: string,
  repo: string,
  branch: string,
  options: { timeoutMs?: number; intervalMs?: number; verifyUrl?: boolean } = {},
): Promise<PagesResult> {
  const res = await fetch(`${GH}/repos/${repo}/pages`, {
    method: 'POST', headers: ghHeaders(token, true),
    body: JSON.stringify({ source: { branch, path: '/' } }),
  }).catch(() => null)
  const owner = repo.split('/')[0]
  const name = repo.split('/')[1]
  let url = `https://${owner}.github.io/${name}/`
  if (!res?.ok && res?.status !== 409) {
    const err = await res?.json().catch(() => null)
    return { status: 'failed', url, error: `开启 Pages 失败：${(err as any)?.message ?? '未知错误'}` }
  }
  try {
    const data = await res.json()
    if (data?.html_url) url = data.html_url
  } catch {}

  const timeoutMs = options.timeoutMs ?? 90_000
  const intervalMs = options.intervalMs ?? 3_000
  const deadline = Date.now() + timeoutMs
  do {
    const statusRes = await fetch(`${GH}/repos/${repo}/pages`, { headers: ghHeaders(token) }).catch(() => null)
    if (statusRes?.ok) {
      const data = await statusRes.json().catch(() => null)
      if (data?.html_url) url = data.html_url
      if (data?.status === 'errored') {
        return { status: 'failed', url, error: 'GitHub Pages 构建失败' }
      }
      if (data?.status === 'built') {
        if (options.verifyUrl === false) return { status: 'ready', url }
        const site = await fetch(url, { redirect: 'follow', cache: 'no-store' }).catch(() => null)
        if (site?.ok) return { status: 'ready', url }
      }
    }
    if (Date.now() < deadline) await sleep(intervalMs)
  } while (Date.now() < deadline)

  return { status: 'pending', url }
}
