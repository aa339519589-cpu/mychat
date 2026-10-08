import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { join } from 'node:path'
import test from 'node:test'
import { workspaceTextDiff, verifiedWorkspaceDiffEntry, workspaceDiffPathIsValid, WorkspaceDiffError } from '../lib/agent/workspace-text-diff'
import { computeManifestDigest, computeTreeDigest, sha256 } from '../lib/agent/snapshot/cas-integrity'
import type { SnapshotEntry, SnapshotManifest } from '../lib/agent/snapshot/cas-types'

const userId = '11111111-1111-4111-8111-111111111111'
const taskId = '22222222-2222-4222-8222-222222222222'
const snapshotId = '33333333-3333-4333-8333-333333333333'
const oldContent = Buffer.from('before\n'), currentContent = Buffer.from('after\n')
const oldOid = createHash('sha1').update(`blob ${oldContent.length}\0`).update(oldContent).digest('hex')

type Scenario = {
  unauthenticated?: boolean; anonymous?: boolean; authUnavailable?: boolean; taskMissing?: boolean;
  taskWrongOwner?: boolean; taskError?: boolean; noAuthority?: boolean; authorityError?: boolean;
  staleAfterRead?: boolean; disconnected?: boolean; credentialWrongOwner?: boolean; sessionWrongOwner?: boolean;
  rate?: 'denied' | 'unavailable'; oversized?: boolean; symlink?: boolean; diffError?: Error;
  repository?: string | null;
}

function fixture(scenario: Scenario = {}) {
  const entry: SnapshotEntry = { path: 'src/file.txt', kind: scenario.symlink ? 'symlink' : 'file', change: 'modified',
    mode: 0o644, size: scenario.oversized ? 256 * 1024 + 1 : currentContent.length, digest: sha256(currentContent) }
  const unsigned: Omit<SnapshotManifest, 'manifestDigest'> = { schemaVersion: 1, scope: 'git-working-tree', snapshotId,
    taskId, userId, reason: 'private route fixture', createdAt: '2026-10-08T00:00:00Z', head: 'c'.repeat(40),
    parentSnapshotId: null, parentDigest: null, entries: [entry], treeDigest: computeTreeDigest([entry]) }
  const manifest = { ...unsigned, manifestDigest: computeManifestDigest(unsigned) }
  const authority = { userId, taskId, snapshotId, manifestDigest: manifest.manifestDigest,
    treeDigest: manifest.treeDigest, head: manifest.head, version: 7 }
  const calls = { auth: [] as Request[], rate: [] as unknown[], filters: [] as Record<string, string>[],
    authority: [] as unknown[], github: [] as unknown[], readers: [] as unknown[], diff: [] as unknown[], downloads: 0, sessions: 0 }
  const client = {
    auth: { async getSession() {
      calls.sessions++
      return { data: { session: { access_token: 'test-secret', user: { id: scenario.sessionWrongOwner ? 'other' : userId } } }, error: null }
    } },
    from(table: string) {
      assert.equal(table, 'agent_tasks')
      const filters: Record<string, string> = {}
      return {
        select(value: string) { assert.equal(value, 'id,user_id,repo'); return this },
        eq(key: string, value: string) { filters[key] = value; return this },
        abortSignal(signal: AbortSignal) { assert.equal(signal.aborted, false); return this },
        async maybeSingle() {
          calls.filters.push({ ...filters })
          return { error: scenario.taskError ? { message: 'fixture-secret-database-error' } : null,
            data: scenario.taskMissing ? null : { id: taskId, user_id: scenario.taskWrongOwner ? 'other' : userId,
              repo: Object.hasOwn(scenario, 'repository') ? scenario.repository : 'acme/repo' } }
        },
      }
    },
  }
  const dependencies = {
    async resolveAuth(request: Request) {
      calls.auth.push(request)
      return { userId: scenario.unauthenticated ? null : userId, supabase: scenario.unauthenticated ? null : client,
        isAnonymous: scenario.anonymous === true, authUnavailable: scenario.authUnavailable === true, isOwner: true }
    },
    requestId: (_request: Request) => 'fixture-request-id',
    async checkRateLimit(key: string, options: unknown) {
      calls.rate.push({ key, options })
      return { allowed: !scenario.rate, remaining: 11, retryAfterSeconds: 4,
        backend: scenario.rate === 'unavailable' ? 'unavailable' : 'database', unavailable: scenario.rate === 'unavailable' }
    },
    async readWorkspaceAuthorityView(value: unknown, owner: string, task: string) {
      assert.equal(value, client); assert.equal(owner, userId); assert.equal(task, taskId)
      calls.authority.push({ owner, task })
      if (scenario.authorityError) throw new Error('fixture-secret-authority-error')
      if (scenario.noAuthority) return null
      return { authority: { ...authority, version: scenario.staleAfterRead && calls.authority.length > 1 ? 8 : 7 }, manifest }
    },
    async getGitHubSession(options: unknown) {
      calls.github.push(options)
      return scenario.disconnected ? null : { userId: scenario.credentialWrongOwner ? 'other' : userId,
        token: 'synthetic-github-token', login: 'fixture-login' }
    },
    createWorkspaceDiffReaders(value: unknown) {
      calls.readers.push(value)
      return {
        async baseline() { calls.downloads++; return { kind: 'file' as const, content: oldContent, oid: oldOid, mode: '100644' as const } },
        async snapshot() { calls.downloads++; return currentContent },
      }
    },
    async workspaceTextDiff(...args: Parameters<typeof workspaceTextDiff>) {
      calls.diff.push(args[0])
      if (scenario.diffError) throw scenario.diffError
      return workspaceTextDiff(...args)
    },
    verifiedWorkspaceDiffEntry, workspaceDiffPathIsValid, WorkspaceDiffError,
  }
  const raw = stripTypeScriptTypes(readFileSync(join(process.cwd(), 'lib/agent/workspace-unified-diff-route.ts'), 'utf8'))
    .replace(/^import .+$/gm, '').replace(/^export (?=async function)/gm, '')
  const factory = new Function(...Object.keys(dependencies), `${raw}\nreturn handleWorkspaceUnifiedDiff`)
  const route = factory(...Object.values(dependencies)) as
    (request: Request, id: string, overrides?: object) => Promise<Response>
  const invoke = (request: Request, id = taskId) => route(request, id, {
    storage: () => ({ origin: 'https://fixture.supabase.co', apiKey: 'ci-public-anon-key' }),
  })
  const query = new URLSearchParams({ format: 'unified', path: entry.path, snapshotId,
    manifestDigest: manifest.manifestDigest, head: manifest.head, version: '7' })
  const request = (changes: Record<string, string> = {}, bearer = true, signal?: AbortSignal) => {
    const values = new URLSearchParams(query)
    for (const [key, value] of Object.entries(changes)) values.set(key, value)
    return new Request(`https://fixture.invalid/api/agent/tasks/${taskId}/workspace/diff?${values}`, {
      headers: bearer ? { Authorization: 'Bearer test-token' } : {}, signal,
    })
  }
  return { invoke, calls, query, request, manifest, authority }
}

async function privateBody(response: Response, expected: number) {
  assert.equal(response.status, expected)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.equal(response.headers.get('vary'), 'Authorization, Cookie')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  const body = await response.json()
  assert.doesNotMatch(JSON.stringify(body), /synthetic-github-token|test-token|test-secret|fixture-secret/)
  return body
}

test('native opt-in reads an owned pinned change and returns an uncached real patch', async () => {
  const value = fixture(), request = value.request()
  const body = await privateBody(await value.invoke(request), 200)
  assert.equal(body.status, 'ready'); assert.equal(body.format, 'unified'); assert.match(body.patch, /@@/)
  assert.deepEqual(value.calls.filters, [{ id: taskId, user_id: userId }])
  assert.deepEqual(value.calls.rate, [{ key: `workspace-diff:${userId}`, options: { max: 12, windowMs: 60_000 } }])
  assert.equal(value.calls.auth[0], request)
  assert.deepEqual(value.calls.github, [{ request, purpose: 'workspace.diff.read', requestId: 'fixture-request-id' }])
  assert.equal(value.calls.authority.length, 2); assert.equal(value.calls.downloads, 2); assert.equal(value.calls.sessions, 0)
  const reader = value.calls.readers[0] as { scope: { repository: string }; storage: { token: string; origin: string } }
  assert.equal(reader.scope.repository, 'acme/repo'); assert.equal(reader.storage.token, 'test-token')
  assert.equal(reader.storage.origin, 'https://fixture.supabase.co')
  const input = value.calls.diff[0] as { maxFileBytes: number; maxPatchBytes: number; signal: AbortSignal }
  assert.equal(input.maxFileBytes, 256 * 1024); assert.equal(input.maxPatchBytes, 1024 * 1024)
  assert.equal(input.signal.aborted, false)
})

test('verified browser cookie sessions can read without creating another auth system', async () => {
  const value = fixture()
  await privateBody(await value.invoke(value.request({}, false)), 200)
  assert.equal(value.calls.sessions, 1)
  const reader = value.calls.readers[0] as { storage: { token: string } }
  assert.equal(reader.storage.token, 'test-secret')
})

test('invalid, duplicate and caller-controlled identity/source query fields fail before auth/data reads', async () => {
  const samples: Record<string, string>[] = [{ format: 'summary' }, { path: '../secret' }, { head: 'main' }, { version: '1e3' },
    { version: '9007199254740992' }, { origin: 'https://evil.invalid' }, { userId: 'other' }, { repo: 'other/repo' }, { maxFileBytes: '9999999' }]
  for (const changes of samples) {
    const value = fixture()
    await privateBody(await value.invoke(value.request(changes)), 400)
    assert.equal(value.calls.auth.length, 0); assert.equal(value.calls.downloads, 0)
  }
  const value = fixture(), duplicate = value.request().url + '&head=' + 'd'.repeat(40)
  await privateBody(await value.invoke(new Request(duplicate)), 400)
  assert.equal(value.calls.auth.length, 0)
})

test('missing snapshot binding and unsupported methods never enter the reader', async () => {
  const value = fixture(), query = new URLSearchParams(value.query); query.delete('snapshotId')
  await privateBody(await value.invoke(new Request(`https://fixture.invalid/?${query}`)), 400)
  await privateBody(await value.invoke(new Request(value.request().url, { method: 'POST' })), 405)
  assert.equal(value.calls.downloads, 0)
})

test('unauthenticated, anonymous and unavailable authentication fail closed and uncached', async () => {
  for (const [scenario, status] of [[{ unauthenticated: true }, 401], [{ anonymous: true }, 401],
    [{ authUnavailable: true }, 503]] as const) {
    const value = fixture(scenario)
    await privateBody(await value.invoke(value.request()), status)
    assert.equal(value.calls.rate.length, 0); assert.equal(value.calls.authority.length, 0); assert.equal(value.calls.github.length, 0)
  }
})

test('rate limiting also applies to owners and denies before workspace or credential reads', async () => {
  for (const [rate, status] of [['denied', 429], ['unavailable', 503]] as const) {
    const value = fixture({ rate }), response = await value.invoke(value.request())
    await privateBody(response, status)
    assert.equal(response.headers.get('retry-after'), '4')
    assert.equal(value.calls.filters.length, 0); assert.equal(value.calls.github.length, 0)
  }
})

test('missing/foreign tasks and database failures reveal no workspace content', async () => {
  for (const [scenario, status] of [[{ taskMissing: true }, 404], [{ taskWrongOwner: true }, 404],
    [{ taskError: true }, 503], [{ authorityError: true }, 503]] as const) {
    const value = fixture(scenario)
    await privateBody(await value.invoke(value.request()), status)
    assert.equal(value.calls.github.length, 0); assert.equal(value.calls.downloads, 0)
  }
})

test('unhydrated, stale or nonmember paths are rejected before touching credentials', async () => {
  const absent = fixture({ noAuthority: true })
  await privateBody(await absent.invoke(absent.request()), 409)
  const samples: Record<string, string>[] = [{ version: '8' }, { snapshotId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, { path: 'other.txt' }]
  for (const changes of samples) {
    const value = fixture()
    await privateBody(await value.invoke(value.request(changes)), changes.path ? 404 : 409)
    assert.equal(value.calls.github.length, 0); assert.equal(value.calls.downloads, 0)
  }
})

test('tasks without a repository are rejected without substituting one or reading Git/CAS', async () => {
  for (const repository of [null, '']) {
    const value = fixture({ repository })
    const body = await privateBody(await value.invoke(value.request()), 409)
    assert.equal(body.code, 'REPOSITORY_UNAVAILABLE')
    assert.equal(value.calls.github.length, 0); assert.equal(value.calls.readers.length, 0)
    assert.equal(value.calls.downloads, 0)
  }
})

test('oversized and symlink entries explicitly omit patches without source credential lookups', async () => {
  for (const [scenario, reason] of [[{ oversized: true }, 'file_too_large'], [{ symlink: true }, 'symlink']] as const) {
    const value = fixture(scenario), body = await privateBody(await value.invoke(value.request()), 200)
    assert.equal(body.status, 'omitted'); assert.equal(body.format, 'none'); assert.equal(body.reason, reason)
    assert.equal(body.patch, undefined); assert.equal(value.calls.github.length, 0); assert.equal(value.calls.downloads, 0)
  }
})

test('disconnected or foreign GitHub credentials and mismatched cookie sessions cannot read blobs', async () => {
  for (const [scenario, status, bearer] of [[{ disconnected: true }, 409, true], [{ credentialWrongOwner: true }, 403, true],
    [{ sessionWrongOwner: true }, 401, false]] as const) {
    const value = fixture(scenario)
    await privateBody(await value.invoke(value.request({}, bearer)), status)
    assert.equal(value.calls.readers.length, 0); assert.equal(value.calls.downloads, 0)
  }
})

test('a workspace advance during download discards the now-stale patch', async () => {
  const value = fixture({ staleAfterRead: true })
  const body = await privateBody(await value.invoke(value.request()), 409)
  assert.equal(body.code, 'STALE_AUTHORITY'); assert.equal(body.patch, undefined)
  assert.equal(value.calls.downloads, 2)
})

test('reader errors and timeouts never echo credentials, provider messages or partial patches', async () => {
  for (const [error, status] of [[new WorkspaceDiffError('BODY_LIMIT', 'fixture-secret'), 503],
    [new Error('fixture-secret-github-token'), 503], [new DOMException('fixture-secret', 'TimeoutError'), 504]] as const) {
    const value = fixture({ diffError: error }), body = await privateBody(await value.invoke(value.request()), status)
    assert.equal(body.patch, undefined)
  }
})

test('already canceled requests make no authentication or source requests', async () => {
  const value = fixture(), controller = new AbortController(); controller.abort()
  await privateBody(await value.invoke(value.request({}, true, controller.signal)), 499)
  assert.equal(value.calls.auth.length, 0); assert.equal(value.calls.downloads, 0)
})

test('public API file selects the new implementation only through explicit format opt-in', async () => {
  const source = stripTypeScriptTypes(readFileSync(join(process.cwd(), 'app/api/agent/tasks/[taskId]/workspace/diff/route.ts'), 'utf8'))
    .replace(/^import .+$/gm, '').replace(/^export (?=async function)/gm, '')
  let optIn = 0, oldReads = 0
  const get = new Function('handleWorkspaceUnifiedDiff', 'resolveAuth', 'json', 'readWorkspaceAuthorityView', 'summarizeWorkspaceChanges',
    `${source}\nreturn GET`)(async () => { optIn++; return new Response('opt-in') },
    async () => ({ userId, supabase: {} }), (body: unknown) => Response.json(body),
    async () => { oldReads++; return null }, () => ({ changedFiles: [], summary: { added: 0, modified: 0, deleted: 0 }, hasChanges: false })) as
      (request: Request, context: { params: Promise<{ taskId: string }> }) => Promise<Response>
  const old = await get(new Request('https://fixture.invalid/diff'), { params: Promise.resolve({ taskId }) })
  assert.equal((await old.json()).diffFormat, 'cas-change-summary'); assert.equal(optIn, 0); assert.equal(oldReads, 1)
  await get(fixture().request(), { params: Promise.resolve({ taskId }) })
  assert.equal(optIn, 1); assert.equal(oldReads, 1)
})
