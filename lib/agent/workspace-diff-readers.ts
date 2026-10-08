import { createHash } from 'node:crypto'
import { githubApiFetch } from '../github-api-fetch'
import { isRecord } from '../unknown-value'
import { boundedDiffGet, diffReadSignal, type DiffFetch } from './workspace-diff-http'
import { WorkspaceDiffError, workspaceDiffPathIsValid, type DiffScope, type WorkspaceDiffReaders } from './workspace-text-diff'

type Credential = { ownerId: string; token: string }
type ReaderConfiguration = {
  scope: DiffScope
  path: string
  snapshot: { digest: string; size: number } | null
  github: Credential
  // Use the already-authenticated user's session, never a service-role key.
  // The origin and API key must come from trusted server configuration.
  storage: Credential & { origin: string; apiKey: string }
}
type Transports = { github?: DiffFetch; storage?: DiffFetch }
type GitEntry = { type: string; mode: string; sha: string; size?: number }

function oid(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) }
function segment(value: string): boolean { return /^[A-Za-z0-9_-]{1,200}$/.test(value) }
function token(value: string): boolean { return Boolean(value) && value.length <= 16_384 && !/\s|[\x00-\x1f\x7f]/.test(value) }

function storageOrigin(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname)
      || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/') {
    throw new WorkspaceDiffError('UNSAFE_STORAGE_ORIGIN', 'Storage downloads require the configured Supabase HTTPS origin')
  }
  return url.origin
}

function validateCredentials(value: ReaderConfiguration): void {
  if (value.github.ownerId !== value.scope.userId || value.storage.ownerId !== value.scope.userId
      || !token(value.github.token) || !token(value.storage.token) || !token(value.storage.apiKey)) {
    throw new WorkspaceDiffError('WRONG_CREDENTIAL_SCOPE', 'Diff source credentials must belong to the authenticated owner')
  }
}

function validateBlob(blob: ReaderConfiguration['snapshot']): void {
  if (blob && (!/^[a-f0-9]{64}$/.test(blob.digest)
      || !Number.isSafeInteger(blob.size) || blob.size < 0 || blob.size > 1024 * 1024)) {
    throw new WorkspaceDiffError('INVALID_BLOB', 'Invalid or oversized snapshot blob binding')
  }
}

function validateConfiguration(value: ReaderConfiguration): void {
  const scope = value.scope
  if (!segment(scope.userId) || !segment(scope.taskId) || !segment(scope.snapshotId) || !oid(scope.head)
      || !/^[a-f0-9]{64}$/.test(scope.manifestDigest) || !Number.isSafeInteger(scope.version) || scope.version < 1) {
    throw new WorkspaceDiffError('INVALID_SCOPE', 'Invalid diff reader identity or pinned HEAD')
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(scope.repository)
      || scope.repository.split('/').some(part => part === '.' || part === '..') || !workspaceDiffPathIsValid(value.path)) {
    throw new WorkspaceDiffError('INVALID_PATH', 'Invalid diff repository or path')
  }
  validateCredentials(value)
  validateBlob(value.snapshot)
}

function budget(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1024 * 1024) {
    throw new WorkspaceDiffError('INVALID_LIMIT', 'Invalid source read budget')
  }
}

async function githubObject(url: string, credential: string, maximum: number, signal: AbortSignal, fetcher: DiffFetch) {
  const bytes = await boundedDiffGet(url, { Authorization: `Bearer ${credential}`, Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'mychat-workspace-diff' }, maximum, signal, fetcher)
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { throw new WorkspaceDiffError('INVALID_GITHUB_OBJECT', 'GitHub returned malformed object metadata') }
  if (!isRecord(value)) throw new WorkspaceDiffError('INVALID_GITHUB_OBJECT', 'GitHub returned invalid object metadata')
  return value
}

function selectTreeEntry(value: Record<string, unknown>, expected: string, name: string): GitEntry | null {
  if (value.sha !== expected || value.truncated !== false || !Array.isArray(value.tree) || value.tree.length > 10_000) {
    throw new WorkspaceDiffError('INCOMPLETE_TREE', 'The pinned Git tree is invalid, truncated or oversized')
  }
  const matching = value.tree.filter(item => isRecord(item) && item.path === name)
  if (matching.length === 0) return null
  const item = matching[0]
  if (matching.length !== 1 || !isRecord(item) || !oid(item.sha)
      || typeof item.type !== 'string' || typeof item.mode !== 'string') {
    throw new WorkspaceDiffError('INVALID_GIT_ENTRY', 'The pinned Git tree entry is invalid')
  }
  return { sha: item.sha, type: item.type, mode: item.mode,
    size: typeof item.size === 'number' ? item.size : undefined }
}

async function locateBlob(repoUrl: string, head: string, path: string,
  get: (url: string, maximum: number) => Promise<Record<string, unknown>>): Promise<GitEntry | null> {
  const commit = await get(`${repoUrl}/git/commits/${head}`, 64 * 1024)
  if (commit.sha !== head || !isRecord(commit.tree) || !oid(commit.tree.sha)) {
    throw new WorkspaceDiffError('WRONG_BASELINE_COMMIT', 'GitHub did not return the pinned baseline commit')
  }
  let tree = commit.tree.sha
  const parts = path.split('/')
  for (const [index, part] of parts.entries()) {
    const entry = selectTreeEntry(await get(`${repoUrl}/git/trees/${tree}`, 2 * 1024 * 1024), tree, part)
    if (!entry) return null
    if (index === parts.length - 1) return entry
    if (entry.type !== 'tree' || entry.mode !== '040000') {
      throw new WorkspaceDiffError('NON_DIRECTORY_PATH', 'Baseline paths must not traverse symlinks or submodules')
    }
    tree = entry.sha
  }
  throw new WorkspaceDiffError('INVALID_PATH', 'Missing baseline path')
}

function blobContent(value: Record<string, unknown>, entry: GitEntry, maximum: number): Buffer {
  if (value.sha !== entry.sha || value.size !== entry.size || value.encoding !== 'base64' || typeof value.content !== 'string') {
    throw new WorkspaceDiffError('BASELINE_INTEGRITY', 'GitHub blob metadata differs from the pinned tree')
  }
  const encoded = value.content.replace(/[\r\n]/g, '')
  if (encoded.length > Math.ceil(maximum / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new WorkspaceDiffError('BASELINE_INTEGRITY', 'GitHub blob encoding is invalid or oversized')
  }
  const content = Buffer.from(encoded, 'base64')
  const digest = createHash('sha1').update(`blob ${content.byteLength}\0`).update(content).digest('hex')
  if (content.byteLength !== entry.size || content.toString('base64') !== encoded || digest !== entry.sha) {
    throw new WorkspaceDiffError('BASELINE_INTEGRITY', 'GitHub blob bytes failed size or object-ID verification')
  }
  return content
}

async function readBaseline(repoUrl: string, request: Parameters<WorkspaceDiffReaders['baseline']>[0],
  credential: string, fetcher: DiffFetch): ReturnType<WorkspaceDiffReaders['baseline']> {
  budget(request.maxBytes)
  const signal = diffReadSignal(request.signal, 15_000)
  const get = (url: string, maximum: number) => githubObject(url, credential, maximum, signal, fetcher)
  const entry = await locateBlob(repoUrl, request.head, request.path, get)
  if (!entry) return { kind: 'missing' }
  if (entry.mode === '120000') return { kind: 'symlink', oid: entry.sha, mode: '120000', content: Buffer.alloc(0) }
  if (entry.type !== 'blob' || (entry.mode !== '100644' && entry.mode !== '100755')
      || !Number.isSafeInteger(entry.size) || Number(entry.size) < 0) {
    throw new WorkspaceDiffError('UNSUPPORTED_BASELINE', 'The baseline path is not a regular Git file')
  }
  if (entry.size! > request.maxBytes) return { kind: 'too_large', size: entry.size! }
  const raw = await get(`${repoUrl}/git/blobs/${entry.sha}`, request.maxBytes * 2 + 8192)
  return { kind: 'file', oid: entry.sha, mode: entry.mode, content: blobContent(raw, entry, request.maxBytes) }
}

function matchingSnapshot(request: Parameters<WorkspaceDiffReaders['snapshot']>[0], scope: DiffScope,
  blob: ReaderConfiguration['snapshot']): boolean {
  return Boolean(blob && request.userId === scope.userId && request.taskId === scope.taskId
    && request.snapshotId === scope.snapshotId && request.digest === blob.digest && request.size === blob.size)
}

// This factory binds one server-authorized path and blob. It performs no login,
// credential lookup, grant creation, signing, or network request until read.
export function createWorkspaceDiffReaders(configuration: ReaderConfiguration, transports: Transports = {}): WorkspaceDiffReaders {
  validateConfiguration(configuration)
  const scope = { ...configuration.scope }
  const path = configuration.path
  const blob = configuration.snapshot ? { ...configuration.snapshot } : null
  const github = configuration.github.token
  const storage = { ...configuration.storage, origin: storageOrigin(configuration.storage.origin) }
  const repoUrl = `https://api.github.com/repos/${scope.repository.split('/').map(encodeURIComponent).join('/')}`
  return {
    async baseline(request) {
      request = { ...request }
      if (request.repository !== scope.repository || request.head !== scope.head || request.path !== path) {
        throw new WorkspaceDiffError('WRONG_TASK_SCOPE', 'The baseline request does not match this bound task')
      }
      return readBaseline(repoUrl, request, github, transports.github ?? githubApiFetch)
    },
    async snapshot(request) {
      request = { ...request }
      budget(request.maxBytes)
      if (!matchingSnapshot(request, scope, blob) || request.size > request.maxBytes) {
        throw new WorkspaceDiffError('WRONG_BLOB_SCOPE', 'The CAS request does not match this bound snapshot')
      }
      const object = [scope.userId, scope.taskId, 'blobs', request.digest].map(encodeURIComponent).join('/')
      const url = `${storage.origin}/storage/v1/object/authenticated/agent-snapshots/${object}`
      const content = await boundedDiffGet(url, { Authorization: `Bearer ${storage.token}`, apikey: storage.apiKey,
        Accept: 'application/octet-stream' }, request.size, diffReadSignal(request.signal, 10_000), transports.storage ?? fetch)
      const digest = createHash('sha256').update(content).digest('hex')
      if (content.byteLength !== request.size || digest !== request.digest) {
        throw new WorkspaceDiffError('SNAPSHOT_INTEGRITY', 'Downloaded CAS bytes failed size or digest verification')
      }
      return content
    },
  }
}
