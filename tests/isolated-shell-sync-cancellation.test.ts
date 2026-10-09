import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'

function loadFunctions(path: string, dependencies: Record<string, unknown>, exported: string) {
  const source = readFileSync(new URL('../' + path, import.meta.url), 'utf8')
  const stripped = stripTypeScriptTypes(source, { mode: 'strip' })
    .replace(/^import\s[\s\S]*?from\s+["'][^"']+["']\s*;?\s*$/gm, '')
    .replace(/^export\s+\{[^}]*\}\s+from\s+["'][^"']+["']\s*;?\s*$/gm, '')
    .replace(/^export\s+/gm, '')
  return new Function(...Object.keys(dependencies), stripped + '\nreturn ' + exported + ';')(...Object.values(dependencies))
}

function toolPipeline(runIsolated: (...args: unknown[]) => Promise<unknown>, client: unknown,
  context: Record<string, unknown>, at: (name: string) => Promise<void>, scopeFunctions: Record<string, unknown>) {
  const unavailable = () => { throw new Error('Unexpected external effect') }
  const isRecord = (value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value)
  const createRecorder = () => ({ step: async () => {}, recordToolCall: async (_name: string, _args: unknown, run: () => Promise<unknown>) => run() })
  const runInWorkspace = loadFunctions('lib/agent/shell.ts', {
    spawn: unavailable, existsSync: () => true, join: (...parts: string[]) => parts.join('/'),
    workspacePath: () => '/synthetic/task', checkCommand: () => ({ allowed: true }),
    sanitizeCommandOutput: (value: string) => value, safeResolve: () => '/synthetic/task',
    validatePath: () => ({ ok: true }), createRecorder, runInIsolatedWorkspace: runIsolated,
    agentExecutionBackend: () => 'isolated',
  }, 'runInWorkspace')
  const addArtifact = async () => { await at('report'); return { id: 'synthetic-report' } }
  const runVerification = loadFunctions('lib/agent/verify.ts', {
    existsSync: () => true, workspaceRoot: () => '/synthetic/task',
    detectProjectCommands: () => ({ packageManager: 'none', framework: 'none', hasTypeScript: false,
      confidence: 1, notes: [], installCommand: null, lintCommand: null, typecheckCommand: null,
      testCommand: 'node test.js', buildCommand: null }),
    parseAllErrors: () => ({ totalErrors: 0, totalWarnings: 0, errors: [], summary: '' }),
    redactSensitive: (value: string) => value, addStep: async () => {}, addArtifact, runInWorkspace,
  }, 'runVerification')
  const verifyWithCommand = loadFunctions('lib/code-tools/verification-command.ts', {
    addArtifact, lstatSync: () => ({ isFile: () => true }), runInWorkspace,
    getWorkspaceDiff: () => 'synthetic-diff', workspaceRoot: () => '/synthetic/task',
    redactSensitive: (value: string) => value, safeResolve: () => '/synthetic/task/test.js',
    commandOutput: () => 'synthetic-result',
  }, 'verifyWithCommand')
  const createWorkflowToolHandlers = loadFunctions('lib/code-tools/workflow-handlers.ts', {
    runInWorkspace, runVerification, verifyWithCommand, getTaskDetail: unavailable,
    getChangedFiles: () => ({ ok: true, data: { files: [] } }), getWorkspaceDiff: () => 'synthetic-diff',
    redactSensitive: (value: string) => value, isCodeUserBlocker: unavailable, mergeTaskMeta: unavailable,
    waitForPages: unavailable, readPage: unavailable, commandOutput: () => 'synthetic-result',
    rememberCodeMemory: unavailable, searchExternalCodeContext: unavailable,
  }, 'createWorkflowToolHandlers')
  const createCodeToolExecutor = loadFunctions('lib/code-tools/index.ts', {
    isRecord, memoryTools: [], createFileToolHandlers: () => ({}), createCodeInspectionHandlers: () => ({}), createWorkflowToolHandlers,
  }, 'createCodeToolExecutor')
  const progress = loadFunctions('lib/code-agent/runtime.ts', {}, '({ createCodeRunProgress, createCodeEventCollector })')
  const createAgentRuntime = loadFunctions('lib/jobs/handlers/agent-runtime.ts', {
    ...scopeFunctions,
    process: { env: {} }, agentExecutionBackend: () => 'isolated', createRecorder,
    getChangedFiles: () => ({ ok: true, data: { files: [] } }),
    advanceWorkspaceAuthority: async () => { (context.assertAuthority as () => void)(); await at('authority_checkpoint') },
    buildCodeTools: () => [], createCodeToolExecutor, ...progress, JobRuntimeError: Error,
    executeFencedToolEffect: async (input: { execute: () => Promise<string> }) => ({ result: await input.execute(), replayed: false }),
  }, 'createAgentRuntime')
  return createAgentRuntime(context, { client, repo: 'synthetic/repo', login: 'synthetic-login',
    token: 'test-token', defaultBranch: 'main', repoIsPrivate: false, userId: 'synthetic-user', taskId: 'synthetic-task',
    workspaceReady: true, memoryEnabled: false, sensitiveMemoryEnabled: false,
  }, { append: async () => {}, emit: () => {} })
}

// Execute the production lifecycle with SDK/database/file effects replaced.
// No package install, external sandbox, credential, model or network is used.
function fixture(options: {
  before?: boolean; abortDuring?: string; existing?: boolean; failDuring?: string | string[]; pauseAt?: string; resourceID?: string
  expireOnHostMkdir?: boolean
} = {}) {
  const controller = new AbortController()
  const scopeFunctions = loadFunctions('lib/agent/isolated-sandbox-scope.ts', {},
    '({ createIsolatedSandboxScope, isIsolatedSandboxScope, sandboxCancellation, createdSandboxCleanup })')
  const calls: string[] = []
  const killed: string[] = []
  const connected: string[] = []
  let clock = 50
  let hostContent = 'before'
  let pathChanged = false
  const fence = { jobId: '00000000-0000-4000-8000-000000000001', workerId: 'synthetic-worker', leaseVersion: 1 }
  class SyntheticJobError extends Error {
    code: string
    constructor(code: string, message: string) { super(message); this.code = code }
  }
  const createContext = loadFunctions('lib/jobs/worker-context.ts', {
    assertJobFence: (value: unknown) => { assert.deepEqual(value, fence) },
    JobRuntimeError: SyntheticJobError, log: { info() {} },
  }, 'createJobExecutionContext')
  const context = createContext({ job: { id: fence.jobId, checkpoint: null }, fence,
    execution: { controller, leaseDeadline: 100 }, budget: { assertWithinLimits() {}, consumeToolCall() {},
      reportSandboxTime() {}, remainingSandboxTimeMs: () => 10000 },
    repository: {}, now: () => clock })
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
    files: {
      exists: async () => { await at('remote_exists'); return true },
      getInfo: async () => { await at('remote_info'); return { type: 'file', size: 2, mode: 0o644 } },
      read: async () => { await at('remote_read'); return new Uint8Array([111, 107]) },
    },
  })
  const created = makeSandbox(options.resourceID ?? 'synthetic-created-sandbox')
  const borrowed = makeSandbox('synthetic-borrowed-sandbox')
  const client = {
    from: (table: string) => table === 'agent_workspaces' ? {
      update: () => ({ eq: () => ({ eq: async () => { await at('workspace_save'); return { error: null } } }) }),
    } : ({ select: (fields: string) => ({ eq: () => ({ eq: () => ({ single: async () => {
      await at(fields === 'meta' ? 'metadata' : 'task_owner')
      return { data: { meta: options.existing ? { e2bSandboxId: borrowed.sandboxId, e2bSyncVersion: 1 } : {} } }
    } }) }) }) }),
  }
  const unavailable = () => { throw new Error('Unexpected host filesystem effect') }
  const dependencies = {
    process: { env: {} }, ...scopeFunctions,
    Sandbox: { create: async () => { await at('create'); return created }, connect: async (id: string) => {
      await at('connect'); connected.push(id); return id === created.sandboxId ? created : borrowed
    } },
    chmodSync: () => { calls.push('chmod_host') }, existsSync: unavailable,
    mkdirSync: () => { calls.push('mkdir_host'); if (options.expireOnHostMkdir) clock = 101 }, unlinkSync: unavailable,
    writeFileSync: (_path: string, value: Uint8Array) => { calls.push('write_host'); hostContent = new TextDecoder().decode(value) },
    dirname: () => '/synthetic/task',
    createWorkspaceSnapshot: async () => { await at('local_snapshot'); return { ok: true } }, workspacePath: () => '/synthetic/task',
    redactSensitive: (value: string) => value,
    validatePath: () => ({ ok: !pathChanged, absolute: pathChanged ? '/outside/result.txt' : '/synthetic/task/result.txt' }),
    sanitizeCommandOutput: (value: string) => value,
    containsSourceCredential: () => false, mergeTaskMeta: async () => { await at('save'); return true },
    errorMessage: (value: unknown) => value instanceof Error ? value.message : String(value),
    recordText: (value: Record<string, unknown>, key: string) => String(value[key] ?? ''),
    MAX_ISOLATED_FILE_BYTES: 1024, REMOTE_WORKSPACE_ROOT: '/workspace', isolatedSandboxConfigured: () => true,
    sandboxEgressForRepository: () => [], assertIsolatedManifestUnchanged: async () => { await at('manifest') },
    changedIsolatedWorkspacePaths: async () => { await at('changes'); return ['result.txt'] },
    hydrateIsolatedWorkspace: async () => { await at('hydrate'); return { initial: false, manifestText: '{}' } },
    persistCurrentIsolatedManifest: async () => { await at('remote_manifest_save') },
  }
  const run = loadFunctions('lib/agent/isolated-shell.ts', dependencies, 'runInIsolatedWorkspace')
  const pipeline = toolPipeline(run, client, context, at, scopeFunctions)
  if (options.before) controller.abort()
  return { calls, killed, connected, paused, release, abort: () => controller.abort(), expireLease: () => { clock = 101 },
    replaceHostContent: (value: string) => { hostContent = value }, getHostContent: () => hostContent,
    isAborted: () => controller.signal.aborted,
    changeHostPath: () => { pathChanged = true },
    runTool: (name: string, params: unknown) => pipeline.executeTool(name, params, { toolCallId: 'synthetic-tool-call' }),
    dispose: () => pipeline.dispose(),
    verifiedDiff: () => pipeline.progress.toolState.getVerifiedDiff(),
    run: () => run(client, 'synthetic-user', 'synthetic-task', 'node test.js', {
      signal: controller.signal, assertAuthority: context.assertAuthority,
    }) }
}

test('cancellation during snapshot readback cannot write files or workspace state after authority is lost', async () => {
  const value = fixture({ pauseAt: 'local_snapshot' })
  const operation = value.run()
  await value.paused
  value.abort(); value.release()
  const result = await operation
  assert.equal(result.exitCode, 1)
  assert.deepEqual(value.calls.filter(name => ['write_host', 'chmod_host', 'workspace_save'].includes(name)), [],
    'After cancellation, a late read result must not mutate the host workspace used by the next job lease')
})

for (const stage of ['manifest', 'changes', 'remote_exists', 'remote_info', 'remote_read']) {
  test('cancellation at ' + stage + ' prevents all later workspace writes', async () => {
    const value = fixture({ pauseAt: stage })
    const operation = value.run()
    await value.paused
    value.abort(); value.release()
    assert.equal((await operation).exitCode, 1)
    assert.deepEqual(value.calls.filter(name => ['mkdir_host', 'write_host', 'chmod_host', 'workspace_save'].includes(name)), [])
    assert.equal(value.getHostContent(), 'before')
  })
}

test('late readback after lease expiry consults the real worker authority guard before any write', async () => {
  const value = fixture({ existing: true, pauseAt: 'local_snapshot' })
  const operation = value.run()
  await value.paused
  value.expireLease()
  assert.equal(value.isAborted(), false, 'The delayed renewal timer has not signalled lease expiry yet')
  value.replaceHostContent('new lease data'); value.release()
  assert.equal((await operation).exitCode, 1)
  assert.equal(value.isAborted(), true, 'The production assertAuthority callback detects the expired lease')
  assert.equal(value.getHostContent(), 'new lease data')
  assert.deepEqual(value.killed, [], 'A borrowed sandbox is not cleaned up by the old copyback operation')
  assert.equal(value.calls.includes('workspace_save'), false)
})

test('cancellation while persisting remote manifest never overwrites newer workspace state or rolls back files', async () => {
  const value = fixture({ existing: true, pauseAt: 'remote_manifest_save' })
  const operation = value.run()
  await value.paused
  assert.equal(value.getHostContent(), 'ok', 'The earlier authorized file write completed')
  value.replaceHostContent('new lease data')
  value.abort(); value.release()
  assert.equal((await operation).exitCode, 1)
  assert.equal(value.getHostContent(), 'new lease data')
  assert.equal(value.calls.includes('workspace_save'), false)
  assert.deepEqual(value.killed, [])
})

test('an active lease still copies the verified file and records one workspace update', async () => {
  const value = fixture()
  assert.equal((await value.run()).exitCode, 0)
  assert.equal(value.getHostContent(), 'ok')
  assert.equal(value.calls.filter(name => name === 'write_host').length, 1)
  assert.equal(value.calls.filter(name => name === 'workspace_save').length, 1)
  assert.deepEqual(value.killed, [])
})

for (const [name, params] of [
  ['execute', { command: 'node test.js' }],
  ['verify', { command: 'node test.js' }],
  ['verify', { steps: ['test'], install: false }],
] as const) {
  test('worker authority reaches copyback through actual ' + name + ' ' + JSON.stringify(params), async () => {
    const value = fixture({ existing: true, pauseAt: 'local_snapshot' })
    const pending = value.runTool(name, params)
    await value.paused
    value.expireLease(); value.replaceHostContent('new lease data'); value.release()
    await assert.rejects(pending, /Job lease expired/)
    assert.equal(value.getHostContent(), 'new lease data')
    assert.equal(value.calls.includes('workspace_save'), false)
    assert.equal(value.verifiedDiff(), null)
    assert.deepEqual(value.killed, ['synthetic-created-sandbox'])
  })
}

for (const params of [{ command: 'node test.js' }, { steps: ['test'], install: false }]) {
  test('an active worker still verifies and persists the report for ' + JSON.stringify(params), async () => {
    const value = fixture()
    const result = await value.runTool('verify', params)
    assert.match(result, /通过/)
    assert.equal(value.verifiedDiff(), 'synthetic-diff')
    assert.equal(value.calls.filter(name => name === 'write_host').length, 1)
    assert.equal(value.calls.filter(name => name === 'authority_checkpoint').length, 1)
    assert.deepEqual(value.killed, [])
  })
}

test('lease loss while a verification report is pending cannot grant publication authority', async () => {
  const value = fixture({ pauseAt: 'report' })
  const pending = value.runTool('verify', { command: 'node test.js' })
  await value.paused
  value.expireLease(); value.release()
  await assert.rejects(pending, /Job lease expired/)
  assert.equal(value.verifiedDiff(), null)
  assert.equal(value.calls.includes('authority_checkpoint'), false)
})

test('a path that changes during remote read is validated again before host mutation', async () => {
  const value = fixture({ pauseAt: 'remote_read' })
  const pending = value.run()
  await value.paused
  value.changeHostPath(); value.release()
  assert.equal((await pending).exitCode, 1)
  assert.equal(value.getHostContent(), 'before')
  assert.equal(value.calls.includes('write_host'), false)
  assert.equal(value.calls.includes('workspace_save'), false)
})

test('a synchronous filesystem boundary that crosses the lease deadline cannot proceed to file write', async () => {
  const value = fixture({ existing: true, expireOnHostMkdir: true })
  assert.equal((await value.run()).exitCode, 1)
  assert.equal(value.isAborted(), true)
  assert.equal(value.getHostContent(), 'before')
  assert.equal(value.calls.includes('write_host'), false)
  assert.equal(value.calls.includes('chmod_host'), false)
  assert.equal(value.calls.includes('workspace_save'), false)
  assert.deepEqual(value.killed, [])
})

test('execute and both verification routes share only their worker lease instance', async () => {
  const value = fixture({ existing: true })
  await value.runTool('execute', { command: 'node test.js' })
  await value.runTool('verify', { command: 'node test.js' })
  await value.runTool('verify', { steps: ['test'], install: false })
  assert.equal(value.calls.filter(name => name === 'create').length, 1)
  assert.deepEqual(value.connected, ['synthetic-created-sandbox', 'synthetic-created-sandbox'])
  assert.equal(value.calls.includes('metadata'), false)
  assert.equal(value.verifiedDiff(), 'synthetic-diff')
  await value.dispose()
  assert.deepEqual(value.killed, ['synthetic-created-sandbox'])
})

test('model tool arguments cannot replace the server-owned scope or select a provider sandbox', async () => {
  const value = fixture({ existing: true })
  await value.runTool('execute', { command: 'node test.js', sandboxScope: { userId: 'other-owner' },
    e2bSandboxId: 'synthetic-foreign-sandbox', leaseVersion: 99 })
  assert.equal(value.calls.filter(name => name === 'create').length, 1)
  assert.equal(value.calls.includes('connect'), false)
  assert.equal(value.calls.includes('metadata'), false)
  await value.dispose()
  assert.deepEqual(value.killed, ['synthetic-created-sandbox'])
})
