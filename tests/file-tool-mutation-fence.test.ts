import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'

function load(path: string, dependencies: Record<string, unknown>, exported: string) {
  const source = stripTypeScriptTypes(readFileSync(new URL('../' + path, import.meta.url), 'utf8'), { mode: 'strip' })
    .replace(/^import\s[\s\S]*?from\s+["'][^"']+["']\s*;?\s*$/gm, '')
    .replace(/^export\s+\{[\s\S]*?\}\s+from\s+["'][^"']+["']\s*;?\s*$/gm, '')
    .replace(/^export\s+/gm, '')
  return new Function(...Object.keys(dependencies), source + '\nreturn ' + exported + ';')(...Object.values(dependencies))
}

const patch = 'diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-before\n+old lease content\n'
const commands = [
  ['write_files', { files: [{ path: 'file.txt', content: 'old lease content' }] }],
  ['edit_file', { path: 'file.txt', old_string: 'before', new_string: 'old lease content' }],
  ['delete_files', { paths: ['file.txt'] }],
  ['apply_patch', { patch }],
] as const

function fixture(options: { expireOnMkdir?: boolean; expireOnDryRun?: boolean; abortOnWrite?: boolean } = {}) {
  const authorityFunctions = load('lib/agent/workspace-types.ts', {}, '({ assertWorkspaceMutationActive })')
  const controller = new AbortController()
  let clock = 50
  let content: string | null = 'before'
  const calls: string[] = []
  const writes: string[] = []
  let entered: () => void = () => {}, release: () => void = () => {}
  const paused = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  class SyntheticJobError extends Error {
    code: string
    constructor(code: string, message: string) { super(message); this.code = code }
  }
  const createContext = load('lib/jobs/worker-context.ts', {
    assertJobFence: () => {}, JobRuntimeError: SyntheticJobError, log: { info() {} },
  }, 'createJobExecutionContext')
  const context = createContext({ job: { id: 'synthetic-job', checkpoint: null },
    fence: { jobId: 'synthetic-job', workerId: 'synthetic-worker', leaseVersion: 1 },
    execution: { controller, leaseDeadline: 100 }, now: () => clock,
    budget: { assertWithinLimits() {} }, repository: {},
  })
  const createWorkspaceSnapshot = async () => {
    calls.push('snapshot'); entered(); await gate
    return { ok: true, snapshot: { snapshotId: 'synthetic-snapshot' } }
  }
  const identity = (value: string) => value
  const errorMessage = (value: unknown) => value instanceof Error ? value.message : String(value)
  const unavailable = () => { throw new Error('Unexpected external effect') }
  const root = '/synthetic/workspace'
  const validatePath = (_root: string, path: string) => ({ ok: true, absolute: root + '/' + path, normalized: path })
  const workspace = load('lib/agent/workspace.ts', {
    ...authorityFunctions,
    readFileSync: () => content, writeFileSync: (path: string, value: string) => {
      calls.push('write'); writes.push(path); content = value
      if (options.abortOnWrite) controller.abort(new Error('Synthetic cancellation after first write'))
    },
    unlinkSync: () => { calls.push('delete'); content = null }, existsSync: () => true,
    mkdirSync: () => { calls.push('mkdir'); if (options.expireOnMkdir) clock = 101 }, dirname: () => root, createWorkspaceSnapshot,
    validatePath, isBinaryFile: () => false, fileTooBig: () => false, redactSensitive: identity,
    workspacePath: () => root, workspaceRoot: () => root, getChangedFiles: () => ({ ok: true, data: { files: [] } }),
    getFileDiff: () => 'synthetic diff', errorMessage,
  }, '({ writeWorkspaceFile, editWorkspaceFile, deleteWorkspaceFile })')
  const patchFunctions = load('lib/agent/patch.ts', {
    ...authorityFunctions,
    existsSync: () => true, execSync: (command: string) => {
      calls.push(command)
      if (command === 'git apply --check' && options.expireOnDryRun) clock = 101
      if (command === 'git apply') content = 'old lease content'
      return ''
    }, workspaceRoot: () => root, getWorkspaceDiff: () => 'synthetic diff', createWorkspaceSnapshot,
    validatePath, redactSensitive: identity, errorMessage,
    recordText: (value: Record<string, unknown>, key: string) => String(value[key] ?? ''),
  }, '({ applyWorkspacePatch, dryRunWorkspacePatch })')
  const createFileToolHandlers = load('lib/code-tools/file-handlers.ts', {
    ...authorityFunctions,
    ...workspace, ...patchFunctions, listTree: unavailable, readGithubFile: unavailable,
    getChangedFiles: () => ({ ok: true, data: { files: [] } }), getWorkspaceDiff: () => 'synthetic diff',
    readWorkspaceFile: unavailable, searchWorkspaceFiles: unavailable, redactSensitive: identity,
    classifyFileRisk: () => ({ blocked: false, needsConfirmation: false }),
    isRecord: (value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value),
  }, 'createFileToolHandlers')
  const handlers = createFileToolHandlers({
    wsReady: true, wsTaskId: 'synthetic-task', wsUserId: 'synthetic-owner', supabase: {},
    signal: controller.signal, assertAuthority: context.assertAuthority,
    emit: () => {}, state: { markWaitingForUser: unavailable },
  })
  return { calls, writes, paused, release, read: () => content,
    replace: () => { content = 'new lease content' },
    abort: () => controller.abort(new Error('Synthetic cancellation')),
    expire: () => { clock = 101 },
    run: (name: string, params: unknown) => Promise.resolve(handlers[name](params)).then(
      value => ({ status: 'returned', value }), error => ({ status: 'rejected', error })),
  }
}

for (const [name, params] of commands) {
  for (const loss of ['abort', 'lease'] as const) {
    test(name + ' must not modify a replacement lease file after ' + loss + ' during snapshot', async () => {
      const value = fixture()
      const pending = value.run(name, params)
      await value.paused
      value.replace()
      if (loss === 'abort') value.abort()
      else value.expire()
      value.release()
      const result = await pending
      assert.equal(value.read(), 'new lease content', JSON.stringify({ calls: value.calls, result }))
      assert.equal(value.calls.some(call => ['write', 'delete', 'mkdir', 'git apply'].includes(call)), false)
      assert.equal(result.status, 'rejected')
    })
  }
  test(name + ' still changes the intended file while its lease is active', async () => {
    const value = fixture()
    const pending = value.run(name, params)
    await value.paused; value.release()
    assert.equal((await pending).status, 'returned')
    assert.equal(value.read(), name === 'delete_files' ? null : 'old lease content')
  })
  for (const loss of ['abort', 'lease'] as const) {
    test(name + ' rejects an already lost ' + loss + ' before snapshot or filesystem work', async () => {
      const value = fixture()
      if (loss === 'abort') value.abort()
      else value.expire()
      assert.equal((await value.run(name, params)).status, 'rejected')
      assert.deepEqual(value.calls, [])
      assert.equal(value.read(), 'before')
    })
  }
}

test('lease expiry during mkdir prevents the subsequent file write', async () => {
  const value = fixture({ expireOnMkdir: true })
  const pending = value.run('write_files', { files: [{ path: 'file.txt', content: 'old lease content' }] })
  await value.paused; value.release()
  assert.equal((await pending).status, 'rejected')
  assert.deepEqual(value.calls, ['snapshot', 'mkdir'])
  assert.equal(value.read(), 'before')
})

test('lease expiry during patch preview prevents both snapshot and git apply', async () => {
  const value = fixture({ expireOnDryRun: true })
  assert.equal((await value.run('apply_patch', { patch })).status, 'rejected')
  assert.deepEqual(value.calls, ['git apply --check'])
  assert.equal(value.read(), 'before')
})

test('a batch stops after cancellation without touching the next file or rolling back the first', async () => {
  const value = fixture({ abortOnWrite: true })
  const pending = value.run('write_files', { files: [
    { path: 'file.txt', content: 'first completed write' },
    { path: 'second.txt', content: 'must not write' },
  ] })
  await value.paused; value.release()
  assert.equal((await pending).status, 'rejected')
  assert.deepEqual(value.writes, ['/synthetic/workspace/file.txt'])
  assert.equal(value.calls.filter(call => call === 'snapshot').length, 1)
  assert.equal(value.read(), 'first completed write')
})
