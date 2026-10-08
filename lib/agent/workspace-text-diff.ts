import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { parseAndVerifyManifest, sha256 } from './snapshot/cas-integrity'
import type { SnapshotEntry, SnapshotManifest } from './snapshot/cas-types'

const run = promisify(execFile)
const DEFAULT_FILE_BYTES = 256 * 1024
const DEFAULT_PATCH_BYTES = 1024 * 1024

export type DiffScope = {
  userId: string
  taskId: string
  repository: string
  snapshotId: string
  manifestDigest: string
  head: string
  version: number
}

type Authority = Pick<DiffScope, 'snapshotId' | 'manifestDigest' | 'head' | 'version'> & { treeDigest: string }
type OwnedTask = { id: string; userId: string; repository: string }
type Baseline = { kind: 'missing' } | { kind: 'too_large'; size: number }
  | { kind: 'file' | 'symlink'; content: Buffer; oid: string; mode: '100644' | '100755' | '120000' }

export type WorkspaceDiffReaders = {
  // The adapter must resolve this exact commit's tree/blob. A branch name,
  // latest GitHub contents, or a previous CAS snapshot is not a baseline.
  baseline(input: { repository: string; head: string; path: string; maxBytes: number; signal?: AbortSignal }): Promise<Baseline>
  // The storage adapter must bound the transfer before allocating its body.
  snapshot(input: { userId: string; taskId: string; snapshotId: string; digest: string; size: number;
    maxBytes: number; signal?: AbortSignal }): Promise<Buffer>
}

type Omission = 'file_too_large' | 'binary' | 'symlink' | 'patch_too_large'
export type WorkspaceTextDiff =
  | { status: 'ready'; format: 'unified'; scope: DiffScope; path: string; patch: string;
      baselineOid: string | null; snapshotDigest: string | null; oldBytes: number; newBytes: number }
  | { status: 'omitted'; format: 'none'; scope: DiffScope; path: string; reason: Omission }

export class WorkspaceDiffError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'WorkspaceDiffError'
    this.code = code
  }
}

function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new WorkspaceDiffError('INVALID_LIMIT', 'Diff limit is outside the supported bound')
  }
  return value
}

function validScope(scope: DiffScope): boolean {
  return Boolean(scope.userId && scope.taskId && /^[a-f0-9]{40}$/.test(scope.head)
    && Number.isSafeInteger(scope.version) && scope.version > 0
    && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(scope.repository)
    && !scope.repository.split('/').some(part => part === '.' || part === '..'))
}

export function workspaceDiffPathIsValid(path: string): boolean {
  return Boolean(path && path.length <= 4096 && !/[\x00-\x1f\x7f\\]/.test(path)
    && !path.startsWith('/') && !/^[A-Za-z]:/.test(path) && path.split('/').length <= 16
    && !path.split('/').some(part => !part || part === '.' || part === '..'))
}

function verifiedManifest(scope: DiffScope, authority: Authority, raw: unknown): SnapshotManifest {
  const verified = parseAndVerifyManifest(raw, { userId: scope.userId, taskId: scope.taskId, snapshotId: scope.snapshotId })
  if (!verified.ok || verified.manifest.manifestDigest !== authority.manifestDigest
      || verified.manifest.treeDigest !== authority.treeDigest || verified.manifest.head !== authority.head) {
    throw new WorkspaceDiffError('INVALID_MANIFEST', 'The manifest does not match this owned workspace authority')
  }
  return verified.manifest
}

function checkedEntry(scope: DiffScope, task: OwnedTask, authority: Authority, raw: unknown, path: string): SnapshotEntry {
  if (task.id !== scope.taskId || task.userId !== scope.userId || task.repository !== scope.repository) {
    throw new WorkspaceDiffError('WRONG_TASK_SCOPE', 'The repository is not bound to this owned task')
  }
  if (!validScope(scope)) throw new WorkspaceDiffError('INVALID_SCOPE', 'Invalid workspace diff scope')
  if (authority.snapshotId !== scope.snapshotId || authority.manifestDigest !== scope.manifestDigest
      || authority.head !== scope.head || authority.version !== scope.version) {
    throw new WorkspaceDiffError('STALE_AUTHORITY', 'The workspace snapshot changed; refresh before reading its diff')
  }
  const manifest = verifiedManifest(scope, authority, raw)
  if (!workspaceDiffPathIsValid(path)) throw new WorkspaceDiffError('INVALID_PATH', 'Invalid workspace-relative path')
  const entry = manifest.entries.find(value => value.path === path)
  if (!entry) throw new WorkspaceDiffError('PATH_NOT_CHANGED', 'The path is not present in this verified snapshot')
  return entry
}

function isText(content: Buffer): boolean {
  if (content.includes(0)) return false
  try { new TextDecoder('utf-8', { fatal: true }).decode(content); return true }
  catch { return false }
}

function verifyBaseline(entry: SnapshotEntry, value: Baseline, maximum: number): Buffer | Omission {
  if (value.kind === 'too_large') return 'file_too_large'
  if (entry.change === 'created') {
    if (value.kind !== 'missing') throw new WorkspaceDiffError('BASELINE_MISMATCH', 'A created path already exists at the pinned HEAD')
    return Buffer.alloc(0)
  }
  if (value.kind === 'missing') throw new WorkspaceDiffError('BASELINE_MISMATCH', 'The pinned HEAD is missing the changed path')
  if (value.content.byteLength > maximum) return 'file_too_large'
  if (value.kind === 'symlink' || value.mode === '120000') return 'symlink'
  if (value.mode !== '100644' && value.mode !== '100755') {
    throw new WorkspaceDiffError('BASELINE_INTEGRITY', 'Unsupported Git blob mode')
  }
  const content = Buffer.from(value.content)
  const oid = createHash('sha1').update(`blob ${content.byteLength}\0`).update(content).digest('hex')
  if (!/^[a-f0-9]{40}$/.test(value.oid) || oid !== value.oid) {
    throw new WorkspaceDiffError('BASELINE_INTEGRITY', 'The pinned Git blob failed object-ID verification')
  }
  return isText(content) ? content : 'binary'
}

function quotePatchPath(value: string): string {
  const escaped = [...Buffer.from(value)].map(byte => {
    if (byte === 34 || byte === 92) return '\\' + String.fromCharCode(byte)
    if (byte < 32 || byte >= 127) return '\\' + byte.toString(8).padStart(3, '0')
    return String.fromCharCode(byte)
  }).join('')
  return `"${escaped}"`
}

function relabelPatch(patch: string, path: string, change: SnapshotEntry['change']): string {
  let inHeader = true
  return patch.split('\n').map((line, index) => {
    if (line.startsWith('@@ ')) inHeader = false
    if (!inHeader) return line
    if (index === 0 && line.startsWith('diff --git ')) return `diff --git ${quotePatchPath(`a/${path}`)} ${quotePatchPath(`b/${path}`)}`
    if (line.startsWith('--- ')) return `--- ${change === 'created' ? '/dev/null' : quotePatchPath(`a/${path}`)}`
    if (line.startsWith('+++ ')) return `+++ ${change === 'deleted' ? '/dev/null' : quotePatchPath(`b/${path}`)}`
    return line
  }).join('\n')
}

async function renderPatch(entry: SnapshotEntry, oldContent: Buffer, newContent: Buffer,
  oldExecutable: boolean, maximum: number, signal?: AbortSignal): Promise<string | null> {
  const root = await mkdtemp(join(tmpdir(), 'mychat-readonly-diff-'))
  try {
    await writeFile(join(root, 'before'), oldContent, { mode: 0o600 })
    await writeFile(join(root, 'after'), newContent, { mode: 0o600 })
    if (oldExecutable) await chmod(join(root, 'before'), 0o700)
    if (entry.mode !== null && (entry.mode & 0o100) !== 0) await chmod(join(root, 'after'), 0o700)
    const args = ['--no-pager', 'diff', '--no-index', '--no-color', '--no-ext-diff', '--no-textconv', '--full-index', '--',
      entry.change === 'created' ? '/dev/null' : 'before', entry.change === 'deleted' ? '/dev/null' : 'after']
    let patch: string
    try {
      const result = await run('git', args, { cwd: root, encoding: 'utf8', timeout: 2_000, maxBuffer: maximum,
        signal, env: { PATH: process.env.PATH, HOME: root, LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_ATTR_NOSYSTEM: '1' } })
      patch = result.stdout
    } catch (error) {
      const failure = error as { code?: string | number; stdout?: string }
      if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return null
      if (failure.code !== 1 || typeof failure.stdout !== 'string') throw error
      patch = failure.stdout
    }
    const labeled = relabelPatch(patch, entry.path, entry.change)
    return Buffer.byteLength(labeled) <= maximum ? labeled : null
  } finally { await rm(root, { recursive: true, force: true }) }
}

async function readCurrentBlob(entry: SnapshotEntry, scope: DiffScope, maximum: number,
  readers: WorkspaceDiffReaders, signal?: AbortSignal): Promise<Buffer> {
  if (entry.kind === 'deleted') return Buffer.alloc(0)
  const content = Buffer.from(await readers.snapshot({ userId: scope.userId, taskId: scope.taskId,
    snapshotId: scope.snapshotId, digest: entry.digest!, size: entry.size, maxBytes: maximum, signal }))
  signal?.throwIfAborted()
  if (content.byteLength !== entry.size || sha256(content) !== entry.digest) {
    throw new WorkspaceDiffError('SNAPSHOT_INTEGRITY', 'The snapshot blob failed size or SHA-256 verification')
  }
  return content
}

// This function reads one already-authorized, immutable file change. It never
// enqueues a task, hydrates a repository, publishes, or accesses host source.
export async function workspaceTextDiff(input: {
  scope: DiffScope; task: OwnedTask; authority: Authority; manifest: unknown; path: string;
  maxFileBytes?: number; maxPatchBytes?: number; signal?: AbortSignal
}, readers: WorkspaceDiffReaders): Promise<WorkspaceTextDiff> {
  input.signal?.throwIfAborted()
  const scope = { ...input.scope }
  const maximum = boundedLimit(input.maxFileBytes, DEFAULT_FILE_BYTES, 1024 * 1024)
  const patchMaximum = boundedLimit(input.maxPatchBytes, DEFAULT_PATCH_BYTES, 4 * 1024 * 1024)
  const entry = checkedEntry(scope, input.task, input.authority, input.manifest, input.path)
  const omitted = (reason: Omission): WorkspaceTextDiff => ({ status: 'omitted', format: 'none',
    scope, path: entry.path, reason })
  if (entry.kind === 'symlink') return omitted('symlink')
  if (entry.size > maximum) return omitted('file_too_large')
  const base = { ...await readers.baseline({ repository: scope.repository, head: scope.head,
    path: entry.path, maxBytes: maximum, signal: input.signal }) }
  input.signal?.throwIfAborted()
  const oldContent = verifyBaseline(entry, base, maximum)
  if (typeof oldContent === 'string') return omitted(oldContent)
  const newContent = await readCurrentBlob(entry, scope, maximum, readers, input.signal)
  if (!isText(newContent)) return omitted('binary')
  const patch = await renderPatch(entry, oldContent, newContent,
    base.kind === 'file' && base.mode === '100755', patchMaximum, input.signal)
  if (patch === null) return omitted('patch_too_large')
  return { status: 'ready', format: 'unified', scope, path: entry.path, patch,
    baselineOid: base.kind === 'file' ? base.oid : null, snapshotDigest: entry.digest,
    oldBytes: oldContent.byteLength, newBytes: newContent.byteLength }
}
