import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'

function load(path: string, dependencies: Record<string, unknown>, exported: string) {
  const source = stripTypeScriptTypes(readFileSync(new URL('../' + path, import.meta.url), 'utf8'), { mode: 'strip' })
    .replace(/^import\s[\s\S]*?from\s+["'][^"']+["']\s*;?\s*$/gm, '').replace(/^export\s+/gm, '')
  return new Function(...Object.keys(dependencies), source + '\nreturn ' + exported + ';')(...Object.values(dependencies))
}

test('a still-authorized lease can resume its own sandbox after the configured idle pause', async () => {
  const scopeFunctions = load('lib/agent/isolated-sandbox-scope.ts', {},
    '({ createIsolatedSandboxScope, isIsolatedSandboxScope, sandboxCancellation, createdSandboxCleanup })')
  const unknownValue = load('lib/unknown-value.ts', {}, '({ recordText, errorMessage })')
  const controller = new AbortController()
  const calls: string[] = []
  let now = 0, expiresAt = 0
  let meta: Record<string, unknown> = {}
  const sandbox = {
    sandboxId: 'synthetic-owned-sandbox',
    updateNetwork: async () => {}, kill: async () => { calls.push('kill') },
    commands: { run: async () => {
      calls.push('command')
      if (now >= expiresAt) throw new Error('Synthetic sandbox paused at its configured lifetime')
      return { stdout: 'command completed', stderr: '', exitCode: 0 }
    } },
  }
  const Sandbox = {
    create: async (options: { timeoutMs: number }) => {
      calls.push('create'); expiresAt = now + options.timeoutMs; return sandbox
    },
    connect: async (id: string, options: { timeoutMs: number }) => {
      assert.equal(id, sandbox.sandboxId)
      calls.push('connect-owned'); expiresAt = now + options.timeoutMs; return sandbox
    },
  }
  const client = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({
    single: async () => ({ data: { meta } }),
  }) }) }) }) }
  const unavailable = () => { throw new Error('Unexpected host effect') }
  const run = load('lib/agent/isolated-shell.ts', {
    ...scopeFunctions, ...unknownValue, process: { env: {} }, Sandbox,
    chmodSync: unavailable, existsSync: unavailable, mkdirSync: unavailable, unlinkSync: unavailable,
    writeFileSync: unavailable, dirname: unavailable, createWorkspaceSnapshot: unavailable, workspacePath: unavailable,
    redactSensitive: (value: string) => value, validatePath: unavailable,
    sanitizeCommandOutput: (value: string) => value, containsSourceCredential: unavailable,
    mergeTaskMeta: async (_client: unknown, _owner: string, _task: string, patch: Record<string, unknown>) => {
      meta = { ...meta, ...patch }; return true
    },
    MAX_ISOLATED_FILE_BYTES: 1024, REMOTE_WORKSPACE_ROOT: '/workspace', isolatedSandboxConfigured: () => true,
    sandboxEgressForRepository: () => [], assertIsolatedManifestUnchanged: async () => {},
    changedIsolatedWorkspacePaths: async () => [],
    hydrateIsolatedWorkspace: async () => ({ initial: false, manifestText: '{}' }), persistCurrentIsolatedManifest: unavailable,
  }, 'runInIsolatedWorkspace')
  const scope = scopeFunctions.createIsolatedSandboxScope({
    owner: { userId: 'synthetic-owner', taskId: 'synthetic-task', jobId: 'synthetic-job',
      workerId: 'synthetic-worker', leaseVersion: 1 },
    signal: controller.signal, assertAuthority: () => {}, // the durable worker lease remains renewed
    withCreationReceipt: async (create: () => Promise<string>) => ({ result: await create(), replayed: false }),
  })
  try {
    const options = { signal: controller.signal, sandboxScope: scope }
    assert.equal((await run(client, 'synthetic-owner', 'synthetic-task', 'node test.js', options)).exitCode, 0)
    now = 31 * 60_000
    const result = await run(client, 'synthetic-owner', 'synthetic-task', 'node test.js', options)
    assert.equal(result.exitCode, 0, JSON.stringify({ calls, result }))
    assert.equal(result.stdout, 'command completed')
    assert.equal(calls.filter(value => value === 'create').length, 1)
    assert.equal(calls.filter(value => value === 'connect-owned').length, 1)
  } finally { await scope.dispose() }
})
