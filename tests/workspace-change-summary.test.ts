import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { join } from 'node:path'
import test from 'node:test'
import { summarizeWorkspaceChanges, workspaceGitChangeStatus } from '../lib/agent/workspace-change-summary'
import type { SnapshotEntry } from '../lib/agent/snapshot/cas-types'
import { changedFileBadge, displayedDiff } from '../components/agent-tasks/status'
import type { WorkspaceDiff } from '../components/agent-tasks/types'

function entry(path: string, change: SnapshotEntry['change'], kind: SnapshotEntry['kind'] = 'file'): SnapshotEntry {
  return { path, change, kind: change === 'deleted' ? 'deleted' : kind,
    mode: change === 'deleted' ? null : 0o644,
    size: change === 'deleted' ? 0 : 12,
    digest: change === 'deleted' ? null : 'a'.repeat(64) }
}

const entries = [entry('new.txt', 'created'), entry('updated.txt', 'modified'), entry('removed.txt', 'deleted')]

test('CAS change type, not file kind, determines added/modified/deleted counts', () => {
  assert.deepEqual(summarizeWorkspaceChanges(entries), {
    changedFiles: [{ path: 'new.txt', status: 'added' }, { path: 'updated.txt', status: 'modified' },
      { path: 'removed.txt', status: 'deleted' }],
    summary: { added: 1, modified: 1, deleted: 1 }, hasChanges: true,
  })
})

test('new empty files and new symlinks remain added changes', () => {
  const empty = { ...entry('empty.txt', 'created'), size: 0 }
  const result = summarizeWorkspaceChanges([empty, entry('link', 'created', 'symlink'),
    entry('other-link', 'modified', 'symlink')])
  assert.deepEqual(result.summary, { added: 2, modified: 1, deleted: 0 })
  assert.deepEqual(result.changedFiles.map(file => file.status), ['added', 'added', 'modified'])
})

test('metadata inspection preserves binary and Unicode paths without reading content', () => {
  const input = [entry('assets/picture.bin', 'created'), entry('目录/with spaces.txt', 'modified')]
  for (const item of input) Object.freeze(item)
  Object.freeze(input)
  const before = JSON.stringify(input)
  const result = summarizeWorkspaceChanges(input)
  assert.deepEqual(result.changedFiles.map(file => file.path), input.map(item => item.path))
  assert.equal(JSON.stringify(input), before)
})

test('empty authority entries have the legacy zero-count shape', () => {
  assert.deepEqual(summarizeWorkspaceChanges([]), {
    changedFiles: [], summary: { added: 0, modified: 0, deleted: 0 }, hasChanges: false,
  })
})

test('Git status uses the same change classification as the diff summary', () => {
  const changes = summarizeWorkspaceChanges(entries)
  assert.deepEqual(changes.changedFiles.map(file => workspaceGitChangeStatus[file.status]), ['A', 'M', 'D'])
})

test('existing web presentation accepts the corrected counts and added status', () => {
  const legacy: WorkspaceDiff = { diff: 'DB-authoritative CAS fixture', ...summarizeWorkspaceChanges(entries) }
  assert.deepEqual(legacy.changedFiles.map(file => changedFileBadge(file.status).label), ['A', 'M', 'D'])
  assert.equal(displayedDiff(legacy.diff), legacy.diff)
  assert.equal(typeof legacy.summary.added, 'number')
  assert.equal(typeof legacy.hasChanges, 'boolean')
})

type Scope = { userId: string; taskId: string }
type Route = {
  GET(request: Request, context: { params: Promise<{ taskId: string }> }): Promise<Response>
  POST?(): Promise<Response>
}

function fixture(owner: string | null = 'alice', failAuthority = false, hydrated = true) {
  const requests: (Request | undefined)[] = []
  const scopes: Scope[] = []
  const taskQueries: Record<string, string>[] = []
  const authority = { snapshotId: 'snapshot-a', manifestDigest: 'b'.repeat(64), head: 'c'.repeat(40), version: 7 }
  const view = { authority, manifest: { entries } }
  const client = {
    from(table: string) {
      assert.equal(table, 'agent_tasks')
      const filters: Record<string, string> = {}
      return {
        select(columns: string) { assert.equal(columns, 'agent_branch'); return this },
        eq(key: string, value: string) { filters[key] = value; return this },
        async maybeSingle() {
          taskQueries.push({ ...filters })
          return { data: filters.user_id === 'alice' && filters.id === 'task-a'
            ? { agent_branch: 'code/task-a' } : null }
        },
      }
    },
  }
  return {
    requests, scopes, taskQueries, authority,
    dependencies: {
      async resolveAuth(request?: Request) {
        requests.push(request)
        // An absent incoming request must not accidentally authenticate native
        // Bearer traffic through a browser-only cookie path.
        const verified = request?.headers.get('authorization') === 'Bearer fixture-only-token' ? owner : null
        return { supabase: verified ? client : null, userId: verified }
      },
      json(value: unknown, status = 200) {
        return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
      },
      async readWorkspaceAuthorityView(value: unknown, userId: string, taskId: string) {
        assert.equal(value, client)
        scopes.push({ userId, taskId })
        if (failAuthority) throw new Error('fixture authority unavailable')
        return hydrated && userId === 'alice' && taskId === 'task-a' ? view : null
      },
      summarizeWorkspaceChanges,
      workspaceGitChangeStatus,
    },
  }
}

// Execute each real route body after Node's own TypeScript erasure, replacing
// only its imports with controlled services. No database, cookie, or network
// is accessed by these tests, and the actual response-building code is used.
function route(kind: 'diff' | 'git', services: ReturnType<typeof fixture>): Route {
  const root = process.env.WORKSPACE_ROUTE_FIXTURE_ROOT ?? process.cwd()
  const path = join(root, 'app/api/agent/tasks/[taskId]/workspace', kind, 'route.ts')
  const source = stripTypeScriptTypes(readFileSync(path, 'utf8'))
    .replace(/^import .+$/gm, '')
    .replace(/^export (?=async function)/gm, '')
  const dependencies = services.dependencies
  const factory = new Function(...Object.keys(dependencies), `${source}\nreturn { GET, POST: typeof POST === 'function' ? POST : undefined }`)
  return factory(...Object.values(dependencies)) as Route
}

function request() {
  return new Request('https://fixture.invalid/workspace?userId=bob', {
    headers: { Authorization: 'Bearer fixture-only-token' },
  })
}

test('diff route preserves old field types and labels its CAS summary honestly', async () => {
  const services = fixture()
  const incoming = request()
  const response = await route('diff', services).GET(incoming, { params: Promise.resolve({ taskId: 'task-a' }) })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(services.requests[0], incoming)
  assert.deepEqual(services.scopes, [{ userId: 'alice', taskId: 'task-a' }])
  assert.equal(typeof body.diff, 'string')
  assert.deepEqual(body.changedFiles, summarizeWorkspaceChanges(entries).changedFiles)
  assert.deepEqual(body.summary, { added: 1, modified: 1, deleted: 1 })
  assert.equal(body.diffFormat, 'cas-change-summary')
  assert.match(body.diff, /^DB-authoritative CAS /)
  assert.match(body.diff, /added\tnew\.txt/)
  assert.equal(body.hasChanges, true)
  assert.equal(body.snapshotId, services.authority.snapshotId)
  assert.equal(body.head, services.authority.head)
  assert.equal(body.manifestDigest, services.authority.manifestDigest)
})

test('git route keeps native Bearer request and filters both owner and task', async () => {
  const services = fixture()
  const incoming = request()
  const response = await route('git', services).GET(incoming, { params: Promise.resolve({ taskId: 'task-a' }) })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(services.requests[0], incoming)
  assert.deepEqual(services.scopes, [{ userId: 'alice', taskId: 'task-a' }])
  assert.deepEqual(services.taskQueries, [{ id: 'task-a', user_id: 'alice' }])
  assert.deepEqual(body.changedFiles.map((file: { status: string }) => file.status), ['A', 'M', 'D'])
  assert.equal(body.currentBranch, 'code/task-a')
  assert.equal(body.commitSha, services.authority.head)
  assert.equal(body.authorityVersion, 7)
})

for (const kind of ['diff', 'git'] as const) {
  test(`${kind} route rejects unauthenticated reads before touching workspace data`, async () => {
    const services = fixture(null)
    const response = await route(kind, services).GET(request(), { params: Promise.resolve({ taskId: 'task-a' }) })
    assert.equal(response.status, 401)
    assert.deepEqual(services.scopes, [])
    assert.deepEqual(services.taskQueries, [])
  })

  test(`${kind} route never substitutes another owner or task's authority`, async () => {
    for (const [owner, taskId] of [['bob', 'task-a'], ['alice', 'task-b']]) {
      const services = fixture(owner)
      const response = await route(kind, services).GET(request(), { params: Promise.resolve({ taskId }) })
      assert.equal(response.status, 200)
      const body = await response.json()
      assert.equal(body.hasChanges, false)
      assert.deepEqual(body.changedFiles, [])
      assert.deepEqual(services.scopes, [{ userId: owner, taskId }])
      assert.equal(body.snapshotId, undefined)
      assert.equal(body.manifestDigest, undefined)
    }
  })

  test(`${kind} route reports authority failure instead of claiming an empty workspace`, async () => {
    const services = fixture('alice', true)
    const response = await route(kind, services).GET(request(), { params: Promise.resolve({ taskId: 'task-a' }) })
    assert.equal(response.status, 503)
    const body = await response.json()
    assert.equal(body.error, 'fixture authority unavailable')
    assert.equal(body.hasChanges, undefined)
  })
}

test('unhydrated diff retains string/list/count fields for existing clients', async () => {
  const services = fixture('alice', false, false)
  const response = await route('diff', services).GET(request(), { params: Promise.resolve({ taskId: 'task-a' }) })
  assert.deepEqual(await response.json(), { diff: '', diffFormat: 'cas-change-summary',
    changedFiles: [], summary: { added: 0, modified: 0, deleted: 0 }, hasChanges: false })
})

test('direct Git publication remains disabled', async () => {
  const services = fixture()
  const response = await route('git', services).POST!()
  assert.equal(response.status, 410)
  assert.deepEqual(services.scopes, [])
  assert.deepEqual(services.taskQueries, [])
})
