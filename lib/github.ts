// GitHub API 共享库：列仓库、列文件树、读文件、校验写权限、建分支+提交+开 PR。
// access token 只在服务端从加密连接存储读取，绝不写入 Cookie 或下发前端。
// Code 的 agentic loop（/api/code/chat）与执行端点（/api/code/apply）都复用这一份，杜绝重复实现。
import { isRecord, type UnknownRecord } from '@/lib/unknown-value'
import { safeModelEndpointFetch } from '@/lib/llm/openai-compatible/safe-fetch'

const GH = 'https://api.github.com'

async function responseRecord(response: Response | null | undefined): Promise<UnknownRecord | null> {
  if (!response) return null
  const value = await response.json().catch(() => null)
  return isRecord(value) ? value : null
}

function boundedFetch(input: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<Response> {
  const signals = [init.signal, AbortSignal.timeout(timeoutMs)].filter(Boolean) as AbortSignal[]
  return fetch(input, { ...init, signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals) })
}

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
  const res = await boundedFetch(`${GH}/user/repos?sort=updated&per_page=50&affiliation=owner,collaborator`, { headers: ghHeaders(token) }).catch(() => null)
  if (!res?.ok) return []
  const data = await res.json()
  return (Array.isArray(data) ? data : []).filter(isRecord).flatMap(row => (
    typeof row.name === 'string' && typeof row.full_name === 'string'
      ? [{
          name: row.name,
          full_name: row.full_name,
          private: row.private === true,
          description: typeof row.description === 'string' ? row.description : '',
        }]
      : []
  ))
}

export type RepoMeta = { defaultBranch: string; canPush: boolean; isPrivate: boolean }

// 仓库元信息：默认分支 + 当前用户是否有写权限
export async function repoMeta(token: string, repo: string): Promise<RepoMeta | null> {
  const res = await boundedFetch(`${GH}/repos/${repo}`, { headers: ghHeaders(token) }).catch(() => null)
  if (!res?.ok) return null
  const data = await responseRecord(res)
  if (!data || typeof data.default_branch !== 'string') return null
  const permissions = isRecord(data.permissions) ? data.permissions : null
  return {
    defaultBranch: data.default_branch,
    canPush: permissions?.push === true,
    isPrivate: !!data.private,
  }
}

// 完整文件路径列表（默认分支，递归）。只返回文件（blob），上限 N 条。
export async function listTree(token: string, repo: string, branch: string, limit = 400): Promise<{ paths: string[]; truncated: boolean }> {
  const res = await boundedFetch(`${GH}/repos/${repo}/git/trees/${branch}?recursive=1`, { headers: ghHeaders(token) }).catch(() => null)
  if (!res?.ok) return { paths: [], truncated: false }
  const data = await responseRecord(res)
  if (!data) return { paths: [], truncated: false }
  const blobs = (Array.isArray(data.tree) ? data.tree : [])
    .filter(isRecord)
    .filter(item => item.type === 'blob' && typeof item.path === 'string')
    .map(item => item.path as string)
  return { paths: blobs.slice(0, limit), truncated: blobs.length > limit || data.truncated === true }
}

export type FileContent = { content: string; sha: string }

// 读单个文件内容（解码 base64）+ sha（提交时防并发覆盖必须用到）
export async function readFile(token: string, repo: string, path: string, maxBytes = 120_000): Promise<FileContent | { error: string }> {
  const res = await boundedFetch(`${GH}/repos/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`, { headers: ghHeaders(token) }).catch(() => null)
  if (!res?.ok) return { error: res?.status === 404 ? '文件不存在' : '文件读取失败' }
  const payload: unknown = await res.json().catch(() => null)
  if (Array.isArray(payload)) return { error: '这是一个目录，不是文件' }
  if (!isRecord(payload)) return { error: '文件响应格式无效' }
  const data = payload
  if (typeof data.size === 'number' && data.size > maxBytes) return { error: `文件过大（${Math.round(data.size / 1024)}KB，超过 ${Math.round(maxBytes / 1024)}KB 上限）` }
  const content = Buffer.from(String(data.content ?? '').replace(/\n/g, ''), 'base64').toString('utf-8')
  return typeof data.sha === 'string' ? { content, sha: data.sha } : { error: '文件响应缺少版本标识' }
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
      res = await boundedFetch(`${GH}/user/repos`, {
        method: 'POST', headers: ghHeaders(token, true),
        body: JSON.stringify({ name: tryName, description: description || '', private: isPrivate, auto_init: true }),
      })
    } catch (e) {
      return { error: `网络错误：${e instanceof Error ? e.message : '无法连接到 GitHub'}` }
    }
    if (res.ok) {
      const data = await responseRecord(res)
      if (data && typeof data.full_name === 'string' && typeof data.default_branch === 'string' && typeof data.html_url === 'string') {
        return { fullName: data.full_name, defaultBranch: data.default_branch, htmlUrl: data.html_url }
      }
      return { error: 'GitHub 返回的仓库信息不完整' }
    }
    const err = await responseRecord(res) ?? { message: `HTTP ${res.status} ${res.statusText || ''}`.trim() }
    const raw = JSON.stringify(err ?? {})
    // 重名 → 换个后缀再试
    if (res.status === 422 && /already exists/i.test(raw)) continue
    // 权限/scope 不足
    if (res.status === 403 || res.status === 404) {
      return { error: '当前 GitHub 授权没有创建仓库的权限。请点右上角 @用户名 → 断开 GitHub，再重新连接（会重新授权完整权限）。' }
    }
    // 其他错误
    const errors = Array.isArray(err.errors) ? err.errors : []
    const firstError = isRecord(errors[0]) ? errors[0] : null
    const msg = typeof err.message === 'string'
      ? err.message
      : typeof firstError?.message === 'string' ? firstError.message : `HTTP ${res.status}`
    return { error: `创建仓库失败：${msg}` }
  }
  return { error: '同名仓库已存在多个，请换一个项目名再试。' }
}

// 取某分支 HEAD 的 commit sha；可重试（新建仓库 auto_init 后引用可能稍有延迟）
async function getHeadSha(token: string, repo: string, branch: string, retries = 0): Promise<string | null> {
  for (let i = 0; i <= retries; i++) {
    const res = await boundedFetch(`${GH}/repos/${repo}/git/ref/heads/${branch}`, { headers: ghHeaders(token) }).catch(() => null)
    if (res?.ok) {
      const data = await responseRecord(res)
      const object = isRecord(data?.object) ? data.object : null
      if (typeof object?.sha === 'string') return object.sha
    }
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
  const commitRes = await boundedFetch(`${GH}/repos/${repo}/git/commits/${baseSha}`, { headers: ghHeaders(token) }).catch(() => null)
  if (!commitRes?.ok) return { error: '获取基树失败' }
  const commit = await responseRecord(commitRes)
  const baseTree = isRecord(commit?.tree) ? commit.tree : null
  if (typeof baseTree?.sha !== 'string') return { error: '基树响应格式无效' }
  const baseTreeSha = baseTree.sha

  // 为写入的文件创建 blob；删除项 sha 置 null
  const treeItems: Array<{ path: string; mode: '100644'; type: 'blob'; sha: string | null }> = []
  for (const f of files) {
    if (f.content === null) {
      treeItems.push({ path: f.path, mode: '100644', type: 'blob', sha: null })
      continue
    }
    const blobRes = await boundedFetch(`${GH}/repos/${repo}/git/blobs`, {
      method: 'POST', headers: ghHeaders(token, true),
      body: JSON.stringify({ content: Buffer.from(f.content, 'utf-8').toString('base64'), encoding: 'base64' }),
    }).catch(() => null)
    if (!blobRes?.ok) return { error: `创建 blob 失败 (${f.path})` }
    const blob = await responseRecord(blobRes)
    if (typeof blob?.sha !== 'string') return { error: `Blob 响应格式无效 (${f.path})` }
    treeItems.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha })
  }

  // 新树
  const treeRes = await boundedFetch(`${GH}/repos/${repo}/git/trees`, {
    method: 'POST', headers: ghHeaders(token, true),
    body: JSON.stringify({ base_tree: baseTreeSha, tree: treeItems }),
  }).catch(() => null)
  if (!treeRes?.ok) return { error: '创建树失败' }
  const tree = await responseRecord(treeRes)
  if (typeof tree?.sha !== 'string') return { error: '新树响应格式无效' }
  const newTreeSha = tree.sha

  // 新提交
  const newCommitRes = await boundedFetch(`${GH}/repos/${repo}/git/commits`, {
    method: 'POST', headers: ghHeaders(token, true),
    body: JSON.stringify({ message: message || 'Claude 代码改动', tree: newTreeSha, parents: [baseSha] }),
  }).catch(() => null)
  if (!newCommitRes?.ok) return { error: '创建提交失败' }
  const newCommit = await responseRecord(newCommitRes)
  if (typeof newCommit?.sha !== 'string') return { error: '提交响应格式无效' }
  const newCommitSha = newCommit.sha

  // 推进分支引用
  const refRes = await boundedFetch(`${GH}/repos/${repo}/git/refs/heads/${branch}`, {
    method: 'PATCH', headers: ghHeaders(token, true),
    body: JSON.stringify({ sha: newCommitSha, force: false }),
  }).catch(() => null)
  if (!refRes?.ok) {
    const err = await responseRecord(refRes)
    return { error: `推送失败：${typeof err?.message === 'string' ? err.message : '未知错误'}` }
  }
  return { commitSha: newCommitSha }
}

export type PagesResult =
  | { status: 'ready'; url: string }
  | { status: 'pending'; url: string }
  | { status: 'failed'; url: string; error: string }

export type MergeResult =
  | { merged: true; commitSha: string }
  | { merged: false; error: string }

type PagesWaitOptions = {
  timeoutMs?: number
  intervalMs?: number
  verifyUrl?: boolean
  expectedCommitSha?: string
  siteProbe?: (url: string) => boolean | Promise<boolean>
}

export function canonicalGitHubPagesUrl(repo: string): string {
  const [owner, name] = repo.split('/')
  if (!owner || !name || !/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new Error('GitHub Pages 仓库标识无效')
  }
  const host = `${owner.toLowerCase()}.github.io`
  const isRootSite = name.toLowerCase() === host
  return `https://${host}${isRootSite ? '/' : `/${encodeURIComponent(name)}/`}`
}

export function isCanonicalGitHubPagesUrl(value: unknown, repo: string): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false
  let candidate: URL
  let canonical: URL
  try {
    candidate = new URL(value)
    canonical = new URL(canonicalGitHubPagesUrl(repo))
  } catch {
    return false
  }
  return candidate.protocol === 'https:'
    && !candidate.username
    && !candidate.password
    && !candidate.port
    && !candidate.hash
    && candidate.hostname.toLowerCase() === canonical.hostname
    && candidate.pathname.startsWith(canonical.pathname)
}

async function probeCanonicalGitHubPages(
  repo: string,
  value: string,
  timeoutMs = 15_000,
): Promise<boolean> {
  if (!isCanonicalGitHubPagesUrl(value, repo)) return false
  let current = value
  const signal = AbortSignal.timeout(timeoutMs)
  for (let redirect = 0; redirect <= 3; redirect++) {
    const response = await safeModelEndpointFetch(current, {
      method: 'GET', redirect: 'manual', cache: 'no-store', signal,
      headers: { Accept: 'text/html,application/xhtml+xml' },
    }).catch(() => null)
    if (!response) return false
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      await response.body?.cancel().catch(() => undefined)
      if (!location) return false
      const next = new URL(location, current).toString()
      if (!isCanonicalGitHubPagesUrl(next, repo)) return false
      current = next
      continue
    }
    await response.body?.cancel().catch(() => undefined)
    return response.ok
  }
  return false
}

export async function mergePullRequest(
  token: string,
  repo: string,
  pullNumber: number,
  headSha: string,
): Promise<MergeResult> {
  const res = await boundedFetch(`${GH}/repos/${repo}/pulls/${pullNumber}/merge`, {
    method: 'PUT',
    headers: ghHeaders(token, true),
    body: JSON.stringify({ sha: headSha, merge_method: 'merge' }),
  }).catch(() => null)
  if (!res) return { merged: false, error: '无法连接 GitHub 合并 Pull Request' }
  const data = await res.json().catch(() => null)
  if (!res.ok || !data?.merged) {
    return { merged: false, error: data?.message ?? `GitHub 拒绝合并（HTTP ${res.status}）` }
  }
  return { merged: true, commitSha: String(data.sha ?? '') }
}

export async function waitForPages(
  token: string,
  repo: string,
  options: PagesWaitOptions = {},
  initialUrl?: string,
): Promise<PagesResult> {
  const canonicalUrl = canonicalGitHubPagesUrl(repo)
  let url = initialUrl && isCanonicalGitHubPagesUrl(initialUrl, repo)
    ? initialUrl
    : canonicalUrl
  const timeoutMs = options.timeoutMs ?? 90_000
  const intervalMs = options.intervalMs ?? 3_000
  const deadline = Date.now() + timeoutMs
  do {
    const statusRes = await boundedFetch(`${GH}/repos/${repo}/pages`, { headers: ghHeaders(token) }).catch(() => null)
    if (statusRes?.ok) {
      const data = await statusRes.json().catch(() => null)
      if (isCanonicalGitHubPagesUrl(data?.html_url, repo)) url = data.html_url
      if (data?.status === 'errored') return { status: 'failed', url, error: 'GitHub Pages 构建失败' }
      if (data?.status === 'built') {
        if (options.expectedCommitSha) {
          const buildRes = await boundedFetch(`${GH}/repos/${repo}/pages/builds/latest`, { headers: ghHeaders(token) }).catch(() => null)
          const build = buildRes?.ok ? await buildRes.json().catch(() => null) : null
          if (build?.commit !== options.expectedCommitSha) {
            if (Date.now() < deadline) await sleep(intervalMs)
            continue
          }
          if (build?.status === 'errored') return { status: 'failed', url, error: 'GitHub Pages 最新版本构建失败' }
          if (build?.status !== 'built') {
            if (Date.now() < deadline) await sleep(intervalMs)
            continue
          }
        }
        if (options.verifyUrl === false) return { status: 'ready', url }
        const siteReady = options.siteProbe
          ? await options.siteProbe(url)
          : await probeCanonicalGitHubPages(repo, url)
        if (siteReady) return { status: 'ready', url }
      }
    }
    if (Date.now() < deadline) await sleep(intervalMs)
  } while (Date.now() < deadline)
  return { status: 'pending', url }
}

// 开启 Pages 后等待 GitHub 构建完成，并验证最终网址确实可访问。
export async function enablePages(
  token: string,
  repo: string,
  branch: string,
  options: PagesWaitOptions = {},
): Promise<PagesResult> {
  const res = await boundedFetch(`${GH}/repos/${repo}/pages`, {
    method: 'POST', headers: ghHeaders(token, true),
    body: JSON.stringify({ source: { branch, path: '/' } }),
  }).catch(() => null)
  let url = canonicalGitHubPagesUrl(repo)
  if (!res?.ok && res?.status !== 409) {
    const err = await responseRecord(res)
    return { status: 'failed', url, error: `开启 Pages 失败：${typeof err?.message === 'string' ? err.message : '未知错误'}` }
  }
  if (res.status === 409) {
    const update = await boundedFetch(`${GH}/repos/${repo}/pages`, {
      method: 'PUT', headers: ghHeaders(token, true),
      body: JSON.stringify({ source: { branch, path: '/' } }),
    }).catch(() => null)
    if (!update?.ok) {
      const err = await responseRecord(update)
      return { status: 'failed', url, error: `更新 Pages 失败：${typeof err?.message === 'string' ? err.message : '未知错误'}` }
    }
  }
  try {
    const data = await res.json()
    if (isCanonicalGitHubPagesUrl(data?.html_url, repo)) url = data.html_url
  } catch {}

  return waitForPages(token, repo, options, url)
}
