import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { workspaceTextDiff, WorkspaceDiffError, type WorkspaceDiffReaders } from '../lib/agent/workspace-text-diff'
import { computeManifestDigest, computeTreeDigest, sha256 } from '../lib/agent/snapshot/cas-integrity'
import type { SnapshotEntry, SnapshotManifest } from '../lib/agent/snapshot/cas-types'

function oid(content: Buffer) {
  return createHash('sha1').update(`blob ${content.byteLength}\0`).update(content).digest('hex')
}

function fixture(old: Buffer | null, current: Buffer | null, path = 'src/example.txt', mode = 0o644) {
  const entry: SnapshotEntry = {
    path, kind: current === null ? 'deleted' : 'file', change: old === null ? 'created' : current === null ? 'deleted' : 'modified',
    mode: current === null ? null : mode, size: current?.byteLength ?? 0, digest: current === null ? null : sha256(current),
  }
  const unsigned: Omit<SnapshotManifest, 'manifestDigest'> = {
    schemaVersion: 1, scope: 'git-working-tree', snapshotId: 'snapshot-a', taskId: 'task-a', userId: 'alice',
    reason: 'offline diff fixture', createdAt: '2026-10-08T00:00:00Z', head: 'c'.repeat(40),
    parentSnapshotId: null, parentDigest: null, entries: [entry], treeDigest: computeTreeDigest([entry]),
  }
  const manifest = { ...unsigned, manifestDigest: computeManifestDigest(unsigned) }
  const scope = { userId: 'alice', taskId: 'task-a', repository: 'acme/repo', snapshotId: 'snapshot-a',
    manifestDigest: manifest.manifestDigest, head: manifest.head, version: 1 }
  const calls: { base: unknown[]; snapshot: unknown[] } = { base: [], snapshot: [] }
  const readers: WorkspaceDiffReaders = {
    async baseline(value) {
      calls.base.push(value)
      return old === null ? { kind: 'missing' } : { kind: 'file', content: old, oid: oid(old), mode: '100644' }
    },
    async snapshot(value) { calls.snapshot.push(value); return current ?? Buffer.alloc(0) },
  }
  const input = { scope, task: { id: scope.taskId, userId: scope.userId, repository: scope.repository },
    authority: { ...scope, treeDigest: manifest.treeDigest }, manifest, path }
  return { input, readers, calls, entry, old, current }
}

async function provesApplicable(value: ReturnType<typeof fixture>) {
  const result = await workspaceTextDiff(value.input, value.readers)
  assert.equal(result.status, 'ready')
  if (result.status !== 'ready') return
  assert.equal(result.format, 'unified')
  assert.equal(result.baselineOid, value.old === null ? null : oid(value.old))
  assert.equal(result.snapshotDigest, value.current === null ? null : sha256(value.current))
  const root = await mkdtemp(join(tmpdir(), 'mychat-diff-apply-test-'))
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: root })
    const file = join(root, value.input.path)
    await mkdir(dirname(file), { recursive: true })
    if (value.old !== null) await writeFile(file, value.old, { mode: 0o600 })
    execFileSync('git', ['apply', '--check', '--whitespace=nowarn', '-'], { cwd: root, input: result.patch })
    execFileSync('git', ['apply', '--whitespace=nowarn', '-'], { cwd: root, input: result.patch })
    if (value.current === null) assert.equal(existsSync(file), false)
    else {
      assert.deepEqual(await readFile(file), value.current)
      assert.equal((await stat(file)).mode & 0o100, value.entry.mode! & 0o100)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
}

test('modified file yields an applicable patch against the exact base bytes', async () => {
  await provesApplicable(fixture(Buffer.from('one\ntwo\nthree\n'), Buffer.from('one\nchanged\nthree\n')))
})

test('created and deleted files use real null-file patch semantics', async () => {
  await provesApplicable(fixture(null, Buffer.from('new file\n')))
  await provesApplicable(fixture(Buffer.from('delete me\n'), null))
})

test('empty created and deleted files remain applicable metadata-only patches', async () => {
  await provesApplicable(fixture(null, Buffer.alloc(0)))
  await provesApplicable(fixture(Buffer.alloc(0), null))
})

test('CRLF and absent terminal newline survive patch generation and application', async () => {
  await provesApplicable(fixture(Buffer.from('a\r\nb\r\n'), Buffer.from('a\r\nc\r\n')))
  await provesApplicable(fixture(Buffer.from('old without newline'), Buffer.from('new without newline')))
})

test('Unicode, spaces, quotes and leading hyphens are correctly quoted patch paths', async () => {
  for (const path of ['目录/a b"c.txt', '--option/file.txt']) {
    await provesApplicable(fixture(Buffer.from('before\n'), Buffer.from('after\n'), path))
  }
})

test('header-looking file content is never relabeled as patch metadata', async () => {
  await provesApplicable(fixture(Buffer.from('-- a/before\n++ b/after\n'), Buffer.from('replacement\n')))
})

test('executable-mode change is represented in the real patch', async () => {
  await provesApplicable(fixture(Buffer.from('#!/bin/sh\necho ok\n'), Buffer.from('#!/bin/sh\necho ok\n'), 'run.sh', 0o755))
})

test('reader calls pin repository, HEAD, path, owner and immutable CAS identity', async () => {
  const value = fixture(Buffer.from('before\n'), Buffer.from('after\n'))
  await workspaceTextDiff(value.input, value.readers)
  assert.deepEqual(value.calls.base, [{ repository: 'acme/repo', head: 'c'.repeat(40), path: 'src/example.txt',
    maxBytes: 256 * 1024, signal: undefined }])
  assert.deepEqual(value.calls.snapshot, [{ userId: 'alice', taskId: 'task-a', snapshotId: 'snapshot-a',
    digest: sha256(Buffer.from('after\n')), size: 6, maxBytes: 256 * 1024, signal: undefined }])
})

test('another owner, task or repository is rejected before any provider read', async () => {
  for (const changed of [{ userId: 'bob' }, { taskId: 'task-b' }, { repository: 'other/repo' }]) {
    const value = fixture(Buffer.from('before'), Buffer.from('after'))
    Object.assign(value.input.scope, changed)
    await assert.rejects(workspaceTextDiff(value.input, value.readers), { code: 'WRONG_TASK_SCOPE' })
    assert.deepEqual(value.calls, { base: [], snapshot: [] })
  }
})

test('stale snapshot, digest, HEAD or version never falls back to latest state', async () => {
  for (const changed of [{ snapshotId: 'other' }, { manifestDigest: 'd'.repeat(64) },
    { head: 'e'.repeat(40) }, { version: 2 }]) {
    const value = fixture(Buffer.from('before'), Buffer.from('after'))
    Object.assign(value.input.scope, changed)
    await assert.rejects(workspaceTextDiff(value.input, value.readers), { code: 'STALE_AUTHORITY' })
    assert.deepEqual(value.calls, { base: [], snapshot: [] })
  }
})

test('tampered manifest fails digest verification without downloading content', async () => {
  const value = fixture(Buffer.from('before'), Buffer.from('after'))
  value.input.manifest.entries[0]!.size += 1
  await assert.rejects(workspaceTextDiff(value.input, value.readers), { code: 'INVALID_MANIFEST' })
  assert.deepEqual(value.calls, { base: [], snapshot: [] })
})

test('paths are exact snapshot members with no traversal, absolute or control paths', async () => {
  for (const path of ['../secret', '/etc/passwd', 'C:/file', 'src/../file', 'src\\file', 'src/file\nother', 'other.txt']) {
    const value = fixture(Buffer.from('before'), Buffer.from('after'))
    await assert.rejects(workspaceTextDiff({ ...value.input, path }, value.readers), WorkspaceDiffError)
    assert.deepEqual(value.calls, { base: [], snapshot: [] })
  }
})

test('Git baseline object ID and CAS byte count/digest are independently verified', async () => {
  const old = fixture(Buffer.from('before'), Buffer.from('after'))
  old.readers.baseline = async () => ({ kind: 'file', content: Buffer.from('wrong'), oid: oid(Buffer.from('before')), mode: '100644' })
  await assert.rejects(workspaceTextDiff(old.input, old.readers), { code: 'BASELINE_INTEGRITY' })
  for (const blob of [Buffer.from('equal'), Buffer.from('different length')]) {
    const value = fixture(Buffer.from('before'), Buffer.from('after'))
    value.readers.snapshot = async () => blob
    await assert.rejects(workspaceTextDiff(value.input, value.readers), { code: 'SNAPSHOT_INTEGRITY' })
  }
})

test('a missing modified baseline or occupied created baseline is an error, never an empty substitute', async () => {
  const modified = fixture(Buffer.from('before'), Buffer.from('after'))
  modified.readers.baseline = async () => ({ kind: 'missing' })
  await assert.rejects(workspaceTextDiff(modified.input, modified.readers), { code: 'BASELINE_MISMATCH' })
  const created = fixture(null, Buffer.from('new'))
  created.readers.baseline = async () => ({ kind: 'file', content: Buffer.from('old'), oid: oid(Buffer.from('old')), mode: '100644' })
  await assert.rejects(workspaceTextDiff(created.input, created.readers), { code: 'BASELINE_MISMATCH' })
})

test('binary and invalid UTF-8 files are explicitly omitted with no patch string', async () => {
  for (const blob of [Buffer.from([0, 1, 2]), Buffer.from([255, 254, 253])]) {
    const value = fixture(Buffer.from('before'), blob)
    const result = await workspaceTextDiff(value.input, value.readers)
    assert.equal(result.status, 'omitted')
    if (result.status === 'omitted') assert.equal(result.reason, 'binary')
    assert.equal('patch' in result, false)
  }
})

test('current-file, deleted-base and output patch sizes are bounded without partial patches', async () => {
  const oversized = fixture(Buffer.from('before'), Buffer.alloc(100, 65))
  const current = await workspaceTextDiff({ ...oversized.input, maxFileBytes: 10 }, oversized.readers)
  assert.equal(current.status === 'omitted' && current.reason, 'file_too_large')
  assert.deepEqual(oversized.calls, { base: [], snapshot: [] })
  const deleted = fixture(Buffer.alloc(100, 65), null)
  const base = await workspaceTextDiff({ ...deleted.input, maxFileBytes: 10 }, deleted.readers)
  assert.equal(base.status === 'omitted' && base.reason, 'file_too_large')
  assert.deepEqual(deleted.calls.snapshot, [])
  const bigPatch = fixture(Buffer.from('before\n'), Buffer.from('after\n'))
  const limited = await workspaceTextDiff({ ...bigPatch.input, maxPatchBytes: 32 }, bigPatch.readers)
  assert.equal(limited.status === 'omitted' && limited.reason, 'patch_too_large')
  assert.equal('patch' in limited, false)
})

test('baseline symlinks are not followed or presented as regular file patches', async () => {
  const value = fixture(Buffer.from('before'), Buffer.from('after'))
  value.readers.baseline = async () => ({ kind: 'symlink', content: Buffer.from('/etc/passwd'),
    oid: oid(Buffer.from('/etc/passwd')), mode: '120000' })
  const result = await workspaceTextDiff(value.input, value.readers)
  assert.equal(result.status === 'omitted' && result.reason, 'symlink')
  assert.deepEqual(value.calls.snapshot, [])
})

test('aborted requests and invalid budgets stop before provider reads', async () => {
  const value = fixture(Buffer.from('before'), Buffer.from('after'))
  const controller = new AbortController(); controller.abort()
  await assert.rejects(workspaceTextDiff({ ...value.input, signal: controller.signal }, value.readers))
  await assert.rejects(workspaceTextDiff({ ...value.input, maxFileBytes: -1 }, value.readers), { code: 'INVALID_LIMIT' })
  assert.deepEqual(value.calls, { base: [], snapshot: [] })
})

test('caller mutation during I/O cannot retarget the already-validated scope', async () => {
  const value = fixture(Buffer.from('before'), Buffer.from('after'))
  const original = value.readers.baseline
  value.readers.baseline = async input => {
    const result = await original(input)
    value.input.scope.userId = 'bob'; value.input.scope.repository = 'other/repo'
    return result
  }
  const result = await workspaceTextDiff(value.input, value.readers)
  assert.equal(result.scope.userId, 'alice')
  assert.equal(result.scope.repository, 'acme/repo')
  assert.equal((value.calls.snapshot[0] as { userId: string }).userId, 'alice')
})
