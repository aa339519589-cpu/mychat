import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'

// Execute the production lifecycle with SDK/database/file effects replaced.
// No package install, external sandbox, credential, model or network is used.
function fixture(options: {
  before?: boolean; abortDuring?: string; existing?: boolean; failDuring?: string | string[]; pauseAt?: string; resourceID?: string
  scoped?: boolean
} = {}) {
  const controller = new AbortController()
  const calls: string[] = []
  const killed: string[] = []
  let entered: () => void = () => {}
  let release: () => void = () => {}
  const paused = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const at = async (name: string) => {
    calls.push(name)
    if (options.abortDuring === name) controller.abort()
    if (options.pauseAt === name) { entered(); await gate }
    if (options.failDuring === name || Array.isArray(options.failDuring) && options.failDuring.includes(name)) {
      throw new Error('Synthetic ' + name + ' failure')
    }
  }
  const makeSandbox = (sandboxId: string) => ({
    sandboxId,
    kill: async () => { killed.push(sandboxId); await at('kill') },
    updateNetwork: async () => { await at('network') },
    commands: { run: async () => { await at('command'); return { stdout: 'ok', stderr: '', exitCode: 0 } } },
  })
  const created = makeSandbox(options.resourceID ?? 'synthetic-created-sandbox')
  const borrowed = makeSandbox('synthetic-borrowed-sandbox')
  const client = {
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ single: async () => {
      await at('metadata'); return { data: { meta: options.existing ? { e2bSandboxId: borrowed.sandboxId, e2bSyncVersion: 1 } : {} } }
    } }) }) }) }),
  }
  const unavailable = () => { throw new Error('Unexpected host filesystem effect') }
  const scopeSource = stripTypeScriptTypes(readFileSync(new URL('../lib/agent/isolated-sandbox-scope.ts', import.meta.url), 'utf8'), { mode: 'strip' })
    .replace(/^import\s[\s\S]*?from\s+["'][^"']+["']\s*;?\s*$/gm, '').replace(/^export\s+/gm, '')
  const scopeFunctions = new Function(scopeSource +
    '\nreturn { sandboxCancellation, createdSandboxCleanup, createIsolatedSandboxScope, isIsolatedSandboxScope };')()
  const scope = options.scoped ? scopeFunctions.createIsolatedSandboxScope({
    owner: { userId: 'synthetic-user', taskId: 'synthetic-task', jobId: 'synthetic-job',
      workerId: 'synthetic-worker', leaseVersion: 1 }, signal: controller.signal, assertAuthority: () => {},
    withCreationReceipt: async (create: () => Promise<string>) => ({ result: await create(), replayed: false }),
  }) : undefined
  const dependencies = {
    ...scopeFunctions,
    process: { env: {} },
    Sandbox: { create: async () => { await at('create'); return created }, connect: async () => { await at('connect'); return borrowed } },
    chmodSync: unavailable, existsSync: unavailable, mkdirSync: unavailable, unlinkSync: unavailable,
    writeFileSync: unavailable, dirname: unavailable, createWorkspaceSnapshot: unavailable, workspacePath: unavailable,
    redactSensitive: (value: string) => value, validatePath: unavailable, sanitizeCommandOutput: (value: string) => value,
    containsSourceCredential: unavailable, mergeTaskMeta: async () => { await at('save'); return true },
    errorMessage: (value: unknown) => value instanceof Error ? value.message : String(value),
    recordText: (value: Record<string, unknown>, key: string) => String(value[key] ?? ''),
    MAX_ISOLATED_FILE_BYTES: 1024, REMOTE_WORKSPACE_ROOT: '/workspace', isolatedSandboxConfigured: () => true,
    sandboxEgressForRepository: () => [], assertIsolatedManifestUnchanged: async () => { await at('manifest') },
    changedIsolatedWorkspacePaths: async () => { await at('changes'); return [] },
    hydrateIsolatedWorkspace: async () => { await at('hydrate'); return { initial: false, manifestText: '{}' } },
    persistCurrentIsolatedManifest: unavailable,
  }
  const source = readFileSync(new URL('../lib/agent/isolated-shell.ts', import.meta.url), 'utf8')
  const stripped = stripTypeScriptTypes(source, { mode: 'strip' })
    .replace(/^import\s[\s\S]*?from\s+["'][^"']+["']\s*;?\s*$/gm, '')
    .replace(/^export\s+/gm, '')
  const run = new Function(...Object.keys(dependencies), stripped + '\nreturn runInIsolatedWorkspace;')(...Object.values(dependencies))
  if (options.before) controller.abort()
  return { calls, killed, paused, release, abort: () => controller.abort(),
    run: () => run(client, 'synthetic-user', 'synthetic-task', 'node test.js', { signal: controller.signal, sandboxScope: scope }) }
}

test('already-cancelled execution performs no sandbox acquisition or hydration', async () => {
  const value = fixture({ before: true })
  const result = await value.run()
  assert.equal(result.exitCode, 1)
  assert.deepEqual(value.calls, [])
})

test('cancellation while creating a sandbox kills the late resource before hydration', async () => {
  const value = fixture({ abortDuring: 'create' })
  const result = await value.run()
  assert.equal(result.exitCode, 1)
  assert.deepEqual(value.calls, ['metadata', 'create', 'kill'])
})

test('cancellation while connecting an existing sandbox never falls back to creating another', async () => {
  const value = fixture({ existing: true, abortDuring: 'connect' })
  const result = await value.run()
  assert.equal(result.exitCode, 1)
  assert.deepEqual(value.calls, ['metadata', 'connect'])
})

test('cancellation during hydration kills the sandbox and never starts the command', async () => {
  const value = fixture({ abortDuring: 'hydrate' })
  const result = await value.run()
  assert.equal(result.exitCode, 1)
  assert.deepEqual(value.calls, ['metadata', 'create', 'save', 'hydrate', 'kill'])
})

test('successful execution keeps the owned sandbox and completes readback', async () => {
  const value = fixture()
  const result = await value.run()
  assert.equal(result.exitCode, 0)
  assert.deepEqual(value.calls, ['metadata', 'create', 'save', 'hydrate', 'command', 'manifest', 'changes'])
})

test('late SDK create completion after cancellation cleans up exactly the returned resource', async () => {
  const value = fixture({ pauseAt: 'create' })
  const operation = value.run()
  await value.paused
  value.abort(); value.abort(); value.release()
  assert.equal((await operation).exitCode, 1)
  assert.deepEqual(value.calls, ['metadata', 'create', 'kill'])
})

test('late hydration completion after repeated cancellation never runs a command or kills twice', async () => {
  const value = fixture({ pauseAt: 'hydrate' })
  const operation = value.run()
  await value.paused
  value.abort(); value.abort(); value.release()
  assert.equal((await operation).exitCode, 1)
  assert.deepEqual(value.calls, ['metadata', 'create', 'save', 'hydrate', 'kill'])
})

test('fresh sandbox hydration failure releases only the resource created in this call', async () => {
  const value = fixture({ failDuring: 'hydrate' })
  assert.equal((await value.run()).exitCode, 1)
  assert.deepEqual(value.calls, ['metadata', 'create', 'save', 'hydrate', 'kill'])
})

test('borrowed sandbox hydration failure does not release or replace that sandbox', async () => {
  const value = fixture({ existing: true, failDuring: 'hydrate' })
  assert.equal((await value.run()).exitCode, 1)
  assert.deepEqual(value.calls, ['metadata', 'connect', 'network', 'hydrate'])
})

test('borrowed sandbox hydration cancellation does not apply fresh-resource cleanup', async () => {
  const value = fixture({ existing: true, pauseAt: 'hydrate' })
  const operation = value.run()
  await value.paused
  value.abort(); value.release()
  assert.equal((await operation).exitCode, 1)
  assert.deepEqual(value.calls, ['metadata', 'connect', 'network', 'hydrate'])
})

test('failed ownership persistence releases the fresh resource without hydrating', async () => {
  const value = fixture({ failDuring: 'save' })
  assert.equal((await value.run()).exitCode, 1)
  assert.deepEqual(value.calls, ['metadata', 'create', 'save', 'kill'])
})

test('failed cleanup is surfaced once and never retries against another resource', async () => {
  const value = fixture({ abortDuring: 'hydrate', failDuring: 'kill' })
  const result = await value.run()
  assert.equal(result.exitCode, 1)
  assert.match(result.stderr, /新建隔离沙箱清理未确认/)
  assert.deepEqual(value.calls, ['metadata', 'create', 'save', 'hydrate', 'kill'])
})

test('command cancellation shares one cleanup promise with the lifecycle listener', async () => {
  const value = fixture({ abortDuring: 'command' })
  assert.equal((await value.run()).exitCode, 1)
  assert.deepEqual(value.calls, ['metadata', 'create', 'save', 'hydrate', 'command', 'kill'])
})

test('cancellation during final readback cannot report a successful command result', async () => {
  const value = fixture({ abortDuring: 'changes' })
  assert.equal((await value.run()).exitCode, 1)
  assert.deepEqual(value.calls, ['metadata', 'create', 'save', 'hydrate', 'command', 'manifest', 'changes', 'kill'])
})

test('a replacement setup failure kills the newly created resource and preserves the borrowed resource', async () => {
  const value = fixture({ existing: true, failDuring: ['network', 'hydrate'] })
  assert.equal((await value.run()).exitCode, 1)
  assert.deepEqual(value.killed, ['synthetic-created-sandbox'])
})

test('parallel task cancellation cannot release the other task resource', async () => {
  const first = fixture({ pauseAt: 'hydrate', resourceID: 'synthetic-task-a' })
  const second = fixture({ resourceID: 'synthetic-task-b' })
  const pending = first.run()
  await first.paused
  assert.equal((await second.run()).exitCode, 0)
  first.abort(); first.release()
  assert.equal((await pending).exitCode, 1)
  assert.deepEqual(first.killed, ['synthetic-task-a'])
  assert.deepEqual(second.killed, [])
})

test('completed invocations remove cleanup listeners before a sandbox can be reused', async () => {
  const value = fixture()
  assert.equal((await value.run()).exitCode, 0)
  value.abort()
  await Promise.resolve()
  assert.deepEqual(value.killed, [])
})

test('cancellation during metadata read never begins SDK acquisition', async () => {
  const value = fixture({ abortDuring: 'metadata' })
  assert.equal((await value.run()).exitCode, 1)
  assert.deepEqual(value.calls, ['metadata'])
})

test('scoped hydration failure releases only the lease instance and prevents replacement', async () => {
  const value = fixture({ scoped: true, existing: true, failDuring: 'hydrate' })
  assert.equal((await value.run()).exitCode, 1)
  assert.equal((await value.run()).exitCode, 1)
  assert.deepEqual(value.calls, ['create', 'hydrate', 'kill'])
  assert.deepEqual(value.killed, ['synthetic-created-sandbox'])
})

test('scoped cancellation while creating releases the late instance without adopting task metadata', async () => {
  const value = fixture({ scoped: true, existing: true, pauseAt: 'create' })
  const pending = value.run()
  await value.paused
  value.abort(); value.release()
  assert.equal((await pending).exitCode, 1)
  assert.deepEqual(value.calls, ['create', 'kill'])
  assert.deepEqual(value.killed, ['synthetic-created-sandbox'])
})

test('scoped cancellation during hydration shares one cleanup request across all listeners', async () => {
  const value = fixture({ scoped: true, existing: true, pauseAt: 'hydrate' })
  const pending = value.run()
  await value.paused
  value.abort(); value.abort(); value.release()
  assert.equal((await pending).exitCode, 1)
  assert.deepEqual(value.calls, ['create', 'hydrate', 'kill'])
  assert.deepEqual(value.killed, ['synthetic-created-sandbox'])
})

test('scoped cleanup failure remains uncertain and does not connect or create a replacement', async () => {
  const value = fixture({ scoped: true, existing: true, failDuring: ['hydrate', 'kill'] })
  const result = await value.run()
  assert.equal(result.exitCode, 1)
  assert.match(result.stderr, /清理未确认/)
  assert.equal((await value.run()).exitCode, 1)
  assert.deepEqual(value.calls, ['create', 'hydrate', 'kill'])
})
