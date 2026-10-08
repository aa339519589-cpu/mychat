import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createWorkspaceDiffReaders } from '../lib/agent/workspace-diff-readers'
import { boundedDiffBody, boundedDiffGet, diffReadSignal, type DiffFetch } from '../lib/agent/workspace-diff-http'
import { workspaceTextDiff } from '../lib/agent/workspace-text-diff'
import { computeManifestDigest, computeTreeDigest, sha256 } from '../lib/agent/snapshot/cas-integrity'
import type { SnapshotManifest } from '../lib/agent/snapshot/cas-types'

const head = '1'.repeat(40), rootTree = '2'.repeat(40), sourceTree = '3'.repeat(40)
const oldContent = Buffer.from('old content\n'), newContent = Buffer.from('new content\n')
const blobOid = createHash('sha1').update(`blob ${oldContent.length}\0`).update(oldContent).digest('hex')
const digest = sha256(newContent)
const api = 'https://api.github.com/repos/acme/repo'

function config() {
  return { scope: { userId: 'alice', taskId: 'task-a', repository: 'acme/repo', snapshotId: 'snapshot-a',
    manifestDigest: '4'.repeat(64), head, version: 1 }, path: 'src/file.txt', snapshot: { digest, size: newContent.length },
    github: { ownerId: 'alice', token: 'synthetic-github-token' },
    storage: { ownerId: 'alice', token: 'test-token', apiKey: 'ci-public-anon-key', origin: 'https://fixture.supabase.co' } }
}

function baseline(maxBytes = 1024) { return { repository: 'acme/repo', head, path: 'src/file.txt', maxBytes } }
function snapshot(maxBytes = 1024) {
  return { userId: 'alice', taskId: 'task-a', snapshotId: 'snapshot-a', digest, size: newContent.length, maxBytes }
}

function fixture() {
  const requests: { url: string; init: RequestInit }[] = []
  const objects: Record<string, unknown> = {
    [`${api}/git/commits/${head}`]: { sha: head, tree: { sha: rootTree } },
    [`${api}/git/trees/${rootTree}`]: { sha: rootTree, truncated: false,
      tree: [{ path: 'src', type: 'tree', mode: '040000', sha: sourceTree }] },
    [`${api}/git/trees/${sourceTree}`]: { sha: sourceTree, truncated: false,
      tree: [{ path: 'file.txt', type: 'blob', mode: '100644', sha: blobOid, size: oldContent.length }] },
    [`${api}/git/blobs/${blobOid}`]: { sha: blobOid, size: oldContent.length, encoding: 'base64', content: oldContent.toString('base64') },
  }
  const github: DiffFetch = async (url, init) => {
    requests.push({ url, init })
    assert.ok(Object.hasOwn(objects, url), `Unexpected source request: ${url}`)
    return Response.json(objects[url])
  }
  const storage: DiffFetch = async (url, init) => { requests.push({ url, init }); return new Response(Uint8Array.from(newContent)) }
  return { requests, objects, github, storage }
}

test('baseline traversal is pinned commit → direct trees → exact immutable blob', async () => {
  const source = fixture(), readers = createWorkspaceDiffReaders(config(), source)
  const result = await readers.baseline(baseline())
  assert.equal(result.kind, 'file')
  if (result.kind === 'file') { assert.deepEqual(result.content, oldContent); assert.equal(result.oid, blobOid) }
  assert.deepEqual(source.requests.map(value => value.url), Object.keys(source.objects))
  for (const request of source.requests) {
    assert.equal(request.init.method, 'GET'); assert.equal(request.init.redirect, 'error')
    assert.equal(request.init.credentials, 'omit'); assert.equal(request.init.cache, 'no-store')
    assert.equal(new Headers(request.init.headers).get('Authorization'), 'Bearer synthetic-github-token')
    assert.equal(new URL(request.url).origin, 'https://api.github.com')
    assert.equal(new URL(request.url).search, '')
  }
})

test('CAS download uses the bound user session and owner/task/digest object path', async () => {
  const source = fixture(), readers = createWorkspaceDiffReaders(config(), source)
  assert.deepEqual(await readers.snapshot(snapshot()), newContent)
  assert.equal(source.requests.length, 1)
  assert.equal(source.requests[0]!.url, `https://fixture.supabase.co/storage/v1/object/authenticated/agent-snapshots/alice/task-a/blobs/${digest}`)
  const headers = new Headers(source.requests[0]!.init.headers)
  assert.equal(headers.get('authorization'), 'Bearer test-token')
  assert.equal(headers.get('apikey'), 'ci-public-anon-key')
})

test('wrong owner, repository, HEAD, path and snapshot bindings are rejected before network access', async () => {
  const source = fixture(), readers = createWorkspaceDiffReaders(config(), source)
  for (const change of [{ repository: 'other/repo' }, { head: 'main' }, { path: '../file.txt' }]) {
    await assert.rejects(readers.baseline({ ...baseline(), ...change }), { code: 'WRONG_TASK_SCOPE' })
  }
  for (const change of [{ userId: 'bob' }, { taskId: 'task-b' }, { snapshotId: 'snapshot-b' },
    { digest: 'f'.repeat(64) }, { size: 1 }]) {
    await assert.rejects(readers.snapshot({ ...snapshot(), ...change }), { code: 'WRONG_BLOB_SCOPE' })
  }
  assert.deepEqual(source.requests, [])
})

test('configuration rejects traversal, controls, deep paths and non-immutable HEADs', () => {
  for (const path of ['../secret', '/etc/passwd', 'a//b', 'a\\b', 'a\nb', Array(18).fill('a').join('/')]) {
    assert.throws(() => createWorkspaceDiffReaders({ ...config(), path }), { code: 'INVALID_PATH' })
  }
  for (const badHead of ['main', '../main', 'https://evil.invalid', 'a'.repeat(39)]) {
    const value = config(); value.scope.head = badHead
    assert.throws(() => createWorkspaceDiffReaders(value), { code: 'INVALID_SCOPE' })
  }
  const mismatch = config(); mismatch.github.ownerId = 'bob'
  assert.throws(() => createWorkspaceDiffReaders(mismatch), { code: 'WRONG_CREDENTIAL_SCOPE' })
})

test('storage origins cannot add paths, credentials, ports or an attacker suffix', () => {
  for (const origin of ['http://fixture.supabase.co', 'https://fixture.supabase.co.evil.invalid',
    'https://user:pass@fixture.supabase.co', 'https://fixture.supabase.co:444',
    'https://fixture.supabase.co/path', 'https://fixture.supabase.co/?url=evil', 'https://127.0.0.1']) {
    const value = config(); value.storage.origin = origin
    assert.throws(() => createWorkspaceDiffReaders(value), { code: 'UNSAFE_STORAGE_ORIGIN' })
  }
})

test('commit/tree mismatches, truncation and duplicate entries do not become missing files', async () => {
  const scenarios = [
    { key: `${api}/git/commits/${head}`, value: { sha: 'e'.repeat(40), tree: { sha: rootTree } }, code: 'WRONG_BASELINE_COMMIT' },
    { key: `${api}/git/trees/${rootTree}`, value: { sha: 'e'.repeat(40), truncated: false, tree: [] }, code: 'INCOMPLETE_TREE' },
    { key: `${api}/git/trees/${rootTree}`, value: { sha: rootTree, truncated: true, tree: [] }, code: 'INCOMPLETE_TREE' },
    { key: `${api}/git/trees/${rootTree}`, value: { sha: rootTree, truncated: false,
      tree: [1, 2].map(() => ({ path: 'src', type: 'tree', mode: '040000', sha: sourceTree })) }, code: 'INVALID_GIT_ENTRY' },
  ]
  for (const scenario of scenarios) {
    const source = fixture(); source.objects[scenario.key] = scenario.value
    await assert.rejects(createWorkspaceDiffReaders(config(), source).baseline(baseline()), { code: scenario.code })
  }
})

test('symlink and submodule traversal are refused without reading their targets', async () => {
  for (const [type, mode] of [['blob', '120000'], ['commit', '160000']]) {
    const source = fixture()
    source.objects[`${api}/git/trees/${rootTree}`] = { sha: rootTree, truncated: false,
      tree: [{ path: 'src', type, mode, sha: sourceTree }] }
    await assert.rejects(createWorkspaceDiffReaders(config(), source).baseline(baseline()), { code: 'NON_DIRECTORY_PATH' })
    assert.equal(source.requests.length, 2)
  }
})

test('a final symlink is identified and its blob/target is not downloaded', async () => {
  const source = fixture()
  source.objects[`${api}/git/trees/${sourceTree}`] = { sha: sourceTree, truncated: false,
    tree: [{ path: 'file.txt', type: 'blob', mode: '120000', sha: blobOid, size: 15 }] }
  const result = await createWorkspaceDiffReaders(config(), source).baseline(baseline())
  assert.equal(result.kind, 'symlink'); assert.equal(source.requests.length, 3)
})

test('missing paths are reported only after a complete pinned tree lookup', async () => {
  const source = fixture()
  source.objects[`${api}/git/trees/${sourceTree}`] = { sha: sourceTree, truncated: false, tree: [] }
  assert.deepEqual(await createWorkspaceDiffReaders(config(), source).baseline(baseline()), { kind: 'missing' })
  for (const status of [403, 404, 500]) {
    const github: DiffFetch = async () => new Response('unavailable', { status })
    await assert.rejects(createWorkspaceDiffReaders(config(), { github }).baseline(baseline()), { code: 'READ_UNAVAILABLE' })
  }
})

test('oversized baseline entries are identified before downloading the blob', async () => {
  const source = fixture()
  const result = await createWorkspaceDiffReaders(config(), source).baseline(baseline(1))
  assert.deepEqual(result, { kind: 'too_large', size: oldContent.length })
  assert.equal(source.requests.length, 3)
})

test('Git blob size, encoding, canonical base64 and object ID are all checked', async () => {
  for (const change of [{ size: oldContent.length + 1 }, { encoding: 'utf-8' }, { content: '!!!' },
    { content: Buffer.from('bad content\n').toString('base64') }, { sha: 'e'.repeat(40) }]) {
    const source = fixture(), key = `${api}/git/blobs/${blobOid}`
    source.objects[key] = { ...(source.objects[key] as object), ...change }
    await assert.rejects(createWorkspaceDiffReaders(config(), source).baseline(baseline()), { code: 'BASELINE_INTEGRITY' })
  }
})

test('CAS wrong bytes, short bytes and oversized transfer all fail closed', async () => {
  for (const bytes of [Buffer.from('bad content\n'), Buffer.from('short'), Buffer.alloc(100, 65)]) {
    const storage: DiffFetch = async () => new Response(Uint8Array.from(bytes))
    await assert.rejects(createWorkspaceDiffReaders(config(), { storage }).snapshot(snapshot()),
      error => ['BODY_LIMIT', 'SNAPSHOT_INTEGRITY'].includes((error as { code: string }).code))
  }
})

test('redirects and changed response URLs are rejected before reading body bytes', async () => {
  for (const response of [new Response(null, { status: 302, headers: { location: 'https://evil.invalid' } }),
    Object.defineProperty(new Response('secret'), 'url', { value: 'https://evil.invalid/blob' }),
    Object.defineProperty(new Response('secret'), 'redirected', { value: true })]) {
    let calls = 0
    const storage: DiffFetch = async (_url, init) => { calls++; assert.equal(init.redirect, 'error'); return response }
    await assert.rejects(createWorkspaceDiffReaders(config(), { storage }).snapshot(snapshot()), { code: 'UNSAFE_REDIRECT' })
    assert.equal(calls, 1)
  }
})

test('declared and streamed byte limits cancel the response and return no partial body', async () => {
  const samples: Record<string, string>[] = [{ 'content-length': '100' }, { 'content-length': 'invalid' }, {}]
  for (const headers of samples) {
    let canceled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(Buffer.from('1234')) },
      cancel() { canceled = true },
    })
    await assert.rejects(boundedDiffBody(new Response(body, { headers }), 3), { code: 'BODY_LIMIT' })
    assert.equal(canceled, true)
  }
})

test('tiny and zero-byte chunk floods have a finite allocation/iteration budget', async () => {
  let canceled = false, pulls = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array()) }, cancel() { canceled = true },
  })
  await assert.rejects(boundedDiffBody(new Response(body), 100), { code: 'BODY_LIMIT' })
  assert.equal(canceled, true); assert.ok(pulls < 8200)
})

test('abort cancels an in-flight body read instead of leaving it hanging', async () => {
  let canceled = false
  const controller = new AbortController()
  const body = new ReadableStream<Uint8Array>({ pull() {}, cancel() { canceled = true } })
  const reading = boundedDiffBody(new Response(body), 100, controller.signal)
  controller.abort()
  await assert.rejects(reading, { name: 'AbortError' })
  assert.equal(canceled, true)
})

test('invalid download limits and already-aborted signals prevent a fetch', async () => {
  let calls = 0
  const fetcher: DiffFetch = async () => { calls++; return new Response('') }
  const stopped = new AbortController(); stopped.abort()
  await assert.rejects(boundedDiffGet('https://fixture.invalid', {}, 10, stopped.signal, fetcher))
  await assert.rejects(boundedDiffGet('https://fixture.invalid', {}, -1, diffReadSignal(undefined, 100), fetcher), { code: 'INVALID_LIMIT' })
  assert.equal(calls, 0)
})

test('reader configuration and request mutations cannot retarget a bound read', async () => {
  const source = fixture(), value = config(), request = baseline(1)
  const github: DiffFetch = async (url, init) => { request.maxBytes = 1024; return source.github(url, init) }
  const readers = createWorkspaceDiffReaders(value, { github, storage: source.storage })
  value.scope.head = 'f'.repeat(40); value.storage.origin = 'https://other.supabase.co'
  assert.deepEqual(await readers.baseline(request), { kind: 'too_large', size: oldContent.length })
  assert.deepEqual(await readers.snapshot(snapshot()), newContent)
  assert.equal(new URL(source.requests.at(-1)!.url).origin, 'https://fixture.supabase.co')
})

test('bound mocked transports integrate with verified manifest and real patch generation', async () => {
  const value = config(), source = fixture()
  const entries = [{ path: value.path, kind: 'file' as const, change: 'modified' as const,
    mode: 0o644, size: newContent.length, digest }]
  const unsigned: Omit<SnapshotManifest, 'manifestDigest'> = { schemaVersion: 1, scope: 'git-working-tree',
    snapshotId: value.scope.snapshotId, taskId: value.scope.taskId, userId: value.scope.userId,
    reason: 'offline integrated reader fixture', createdAt: '2026-10-08T00:00:00Z', head,
    parentSnapshotId: null, parentDigest: null, entries, treeDigest: computeTreeDigest(entries) }
  const manifest = { ...unsigned, manifestDigest: computeManifestDigest(unsigned) }
  value.scope.manifestDigest = manifest.manifestDigest
  const result = await workspaceTextDiff({ scope: value.scope,
    task: { id: value.scope.taskId, userId: value.scope.userId, repository: value.scope.repository },
    authority: { ...value.scope, treeDigest: manifest.treeDigest }, manifest, path: value.path },
    createWorkspaceDiffReaders(value, source))
  assert.equal(result.status, 'ready')
  if (result.status === 'ready') {
    assert.match(result.patch, /@@/); assert.match(result.patch, /-old content/); assert.match(result.patch, /\+new content/)
    assert.equal(result.baselineOid, blobOid); assert.equal(result.snapshotDigest, digest)
  }
})
