import { resolveAuth, type AuthCtx } from '../api/guard'
import { requestId } from '../api/request'
import { getGitHubSession } from '../github-session'
import { checkRateLimit } from '../rate-limit'
import { readWorkspaceAuthorityView } from './workspace-authority-view'
import { createWorkspaceDiffReaders } from './workspace-diff-readers'
import { verifiedWorkspaceDiffEntry, workspaceDiffPathIsValid, workspaceTextDiff, WorkspaceDiffError, type DiffScope } from './workspace-text-diff'

const MAX_FILE_BYTES = 256 * 1024
const MAX_PATCH_BYTES = 1024 * 1024
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const QUERY_KEYS = ['format', 'path', 'snapshotId', 'manifestDigest', 'head', 'version']
type SignedIn = AuthCtx & { userId: string; supabase: NonNullable<AuthCtx['supabase']> }
type Selection = Pick<DiffScope, 'snapshotId' | 'manifestDigest' | 'head' | 'version'> & { path: string }

const services = {
  authenticate: resolveAuth, rateLimit: checkRateLimit, authority: readWorkspaceAuthorityView,
  github: getGitHubSession, readers: createWorkspaceDiffReaders, diff: workspaceTextDiff,
  storage: () => ({ origin: process.env.NEXT_PUBLIC_SUPABASE_URL ?? '', apiKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '' }),
}

class DiffRouteError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message); this.status = status; this.code = code
  }
}

function privateJSON(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: {
    'Cache-Control': 'private, no-store', Vary: 'Authorization, Cookie',
    Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff',
  } })
}

function selection(request: Request, taskId: string): Selection {
  if (request.method !== 'GET') throw new DiffRouteError(405, 'METHOD_NOT_ALLOWED', '仅支持只读 GET')
  const query = new URL(request.url).searchParams
  if (request.url.length > 16_384 || !UUID.test(taskId)
      || [...query.keys()].some(key => !QUERY_KEYS.includes(key))
      || QUERY_KEYS.some(key => query.getAll(key).length !== 1) || query.get('format') !== 'unified') {
    throw new DiffRouteError(400, 'INVALID_DIFF_REQUEST', '差异请求参数无效')
  }
  const value = { path: query.get('path')!, snapshotId: query.get('snapshotId')!.toLowerCase(),
    manifestDigest: query.get('manifestDigest')!, head: query.get('head')!, version: Number(query.get('version')) }
  if (!workspaceDiffPathIsValid(value.path) || !UUID.test(value.snapshotId)
      || !/^[a-f0-9]{64}$/.test(value.manifestDigest) || !/^[a-f0-9]{40}$/.test(value.head)
      || !/^[1-9][0-9]*$/.test(query.get('version')!) || !Number.isSafeInteger(value.version)) {
    throw new DiffRouteError(400, 'INVALID_DIFF_REQUEST', '必须提供完整且固定的快照标识')
  }
  return value
}

async function bounded<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let abort: () => void = () => undefined
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
  })
  try { return await Promise.race([Promise.resolve(promise), stopped]) }
  finally { signal.removeEventListener('abort', abort) }
}

async function storageToken(request: Request, auth: SignedIn): Promise<string> {
  const authorization = request.headers.get('authorization')
  if (authorization !== null) {
    const bearer = authorization.trim().match(/^Bearer\s+(\S+)$/i)?.[1]
    if (!bearer || bearer.length > 16_384) throw new DiffRouteError(401, 'SESSION_REQUIRED', '需要有效登录会话')
    return bearer
  }
  const { data, error } = await auth.supabase.auth.getSession()
  const session = data.session
  if (error || !session || session.user.id !== auth.userId || !session.access_token) {
    throw new DiffRouteError(401, 'SESSION_REQUIRED', '需要有效登录会话')
  }
  return session.access_token
}

async function ownedWorkspace(auth: SignedIn, taskId: string, signal: AbortSignal, dependencies: typeof services) {
  signal.throwIfAborted()
  const [{ data, error }, view] = await bounded(Promise.all([
    auth.supabase.from('agent_tasks').select('id,user_id,repo').eq('id', taskId)
      .eq('user_id', auth.userId).abortSignal(signal).maybeSingle(),
    dependencies.authority(auth.supabase, auth.userId, taskId),
  ]), signal)
  if (error) throw new DiffRouteError(503, 'WORKSPACE_UNAVAILABLE', '工作区状态暂不可用')
  if (!data || data.id !== taskId || data.user_id !== auth.userId) {
    throw new DiffRouteError(404, 'TASK_NOT_FOUND', '任务不存在')
  }
  if (!view) throw new DiffRouteError(409, 'WORKSPACE_NOT_READY', '工作区尚无可读取的固定快照')
  return { task: { id: data.id, userId: data.user_id, repository: data.repo }, view }
}

async function rateGate(auth: SignedIn, dependencies: typeof services, signal: AbortSignal): Promise<Response | null> {
  const rate = await bounded(dependencies.rateLimit(`workspace-diff:${auth.userId}`, { max: 12, windowMs: 60_000 }), signal)
  if (rate.allowed && !rate.unavailable) return null
  const response = privateJSON({ code: rate.unavailable ? 'RATE_LIMIT_UNAVAILABLE' : 'RATE_LIMITED',
    error: rate.unavailable ? '限流服务暂不可用' : '请求过于频繁，请稍后重试' }, rate.unavailable ? 503 : 429)
  response.headers.set('Retry-After', String(Math.max(1, rate.retryAfterSeconds)))
  return response
}

async function renderOwned(request: Request, taskId: string, selected: Selection, auth: SignedIn,
  signal: AbortSignal, dependencies: typeof services): Promise<Response> {
  const { task, view } = await ownedWorkspace(auth, taskId, signal, dependencies)
  const { path, ...binding } = selected
  const scope: DiffScope = { ...binding, userId: auth.userId, taskId, repository: task.repository }
  const entry = verifiedWorkspaceDiffEntry(scope, task, view.authority, view.manifest, path)
  if (entry.kind === 'symlink' || entry.size > MAX_FILE_BYTES) {
    return privateJSON({ schemaVersion: 1, status: 'omitted', format: 'none', scope, path,
      reason: entry.kind === 'symlink' ? 'symlink' : 'file_too_large' })
  }
  signal.throwIfAborted()
  const [github, accessToken] = await bounded(Promise.all([
    dependencies.github({ request, purpose: 'workspace.diff.read', requestId: requestId(request) }),
    storageToken(request, auth),
  ]), signal)
  if (!github) throw new DiffRouteError(409, 'GITHUB_CONNECTION_REQUIRED', '请先连接 GitHub')
  if (github.userId !== auth.userId) throw new DiffRouteError(403, 'CREDENTIAL_SCOPE_MISMATCH', '连接与当前用户不一致')
  const readers = dependencies.readers({ scope, path,
    snapshot: entry.kind === 'deleted' ? null : { digest: entry.digest!, size: entry.size },
    github: { ownerId: auth.userId, token: github.token },
    storage: { ...dependencies.storage(), ownerId: auth.userId, token: accessToken },
  })
  const result = await bounded(dependencies.diff({ scope, task, authority: view.authority, manifest: view.manifest, path,
    maxFileBytes: MAX_FILE_BYTES, maxPatchBytes: MAX_PATCH_BYTES, signal }, readers), signal)
  const current = await bounded(dependencies.authority(auth.supabase, auth.userId, taskId), signal)
  if (!current) throw new DiffRouteError(409, 'STALE_AUTHORITY', '快照已改变，请刷新后重试')
  verifiedWorkspaceDiffEntry(scope, task, current.authority, current.manifest, path)
  return privateJSON({ schemaVersion: 1, ...result })
}

function errorResponse(error: unknown, request: Request): Response {
  if (request.signal.aborted) return privateJSON({ code: 'REQUEST_ABORTED', error: '读取已取消' }, 499)
  if (error instanceof DiffRouteError) return privateJSON({ code: error.code, error: error.message }, error.status)
  if (error instanceof Error && error.name === 'TimeoutError') {
    return privateJSON({ code: 'DIFF_TIMEOUT', error: '差异读取超时，请重试' }, 504)
  }
  if (error instanceof WorkspaceDiffError) {
    const status = error.code === 'PATH_NOT_CHANGED' ? 404
      : ['STALE_AUTHORITY', 'BASELINE_MISMATCH', 'WRONG_TASK_SCOPE'].includes(error.code) ? 409 : 503
    return privateJSON({ code: error.code, error: '无法读取已验证的差异，请刷新后重试' }, status)
  }
  return privateJSON({ code: 'DIFF_UNAVAILABLE', error: '差异读取暂不可用，请稍后重试' }, 503)
}

export async function handleWorkspaceUnifiedDiff(request: Request, taskId: string,
  overrides: Partial<typeof services> = {}): Promise<Response> {
  const dependencies = { ...services, ...overrides }
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)])
  try {
    signal.throwIfAborted()
    const targetTaskId = taskId.toLowerCase()
    const selected = selection(request, targetTaskId)
    const auth = await bounded(dependencies.authenticate(request), signal)
    if (auth.authUnavailable) throw new DiffRouteError(503, 'AUTH_UNAVAILABLE', '登录验证暂不可用')
    if (!auth.userId || !auth.supabase || auth.isAnonymous) throw new DiffRouteError(401, 'AUTH_REQUIRED', '请先登录')
    const signedIn = { ...auth, userId: auth.userId, supabase: auth.supabase }
    const limited = await rateGate(signedIn, dependencies, signal)
    return limited ?? await renderOwned(request, targetTaskId, selected, signedIn, signal, dependencies)
  } catch (error) { return errorResponse(error, request) }
}
